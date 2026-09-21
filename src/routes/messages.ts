// src/routes/messages.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  getThreadsNeedingReply, getThreadById, getMessagesByThread,
  getLastMessageSync, markThreadAiNoReply, markThreadDiscarded, getMessagesSince, type MessageFeedRow,
} from '../repositories/message-repository.js';
import {
  createDraft, getDraftById, getActiveDraftByThread, discardDraft,
  claimDraftForSending, updateDraftBody, setSentBodyChanged,
  getAutoSendStats, countAutoSentSince, listAutoDecisions, getLastSentDraftByThread,
} from '../repositories/draft-repository.js';
import { getSchedulerState, setSchedulerState } from '../repositories/scheduler-state-repository.js';
import { getPropertiesByProvider } from '../config/properties.js';
import { getPropertyForThread, propertyForBadge } from '../utils/thread-property.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread, DRAFT_MODEL } from '../services/draft-service.js';
import { buildBookingContext } from '../services/booking-context.js';
import { detectBookingRequestContext } from '../services/booking-request.js';
import { sendClaimedDraft } from '../services/draft-send-service.js';
import { resolveOutboundModuleType } from '../services/guesty-channel.js';
import { getHostexClient, type HostexConversationDetail } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from '../jobs/hostex/sync-hostex-messages.js';
import { syncGuestyMessagesForProperty, fetchAllConversations } from '../jobs/sync-guesty-messages.js';
import { generateDraftsForProperty } from '../jobs/generate-drafts.js';
import { acquireMessageSyncLock, messageSyncLock } from '../jobs/message-loop.js';
import logger from '../utils/logger.js';
import { renderAdminPage } from './admin-layout.js';
import { createFeedback, createSuggestion, countPendingSuggestions } from '../repositories/feedback-repository.js';
import { generateSuggestion } from '../services/suggestion-service.js';
import { PAUSE_KEY } from '../services/auto-send/runner.js';
import { startOfBerlinDayIso, formatBerlinDeadline } from '../services/auto-send/berlin-day.js';
import { config } from '../config/index.js';
import type { MessageDraft } from '../types/messages.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Robust UTC parse for DB timestamps (ISO "…Z" or SQLite "YYYY-MM-DD HH:MM:SS").
function parseUtc(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

// ISO timestamp -> "2026-06-29 08:37" (trim seconds/timezone for readability).
function fmtDate(iso: string | null | undefined): string {
  const s = String(iso ?? '');
  return s.length >= 16 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s;
}


function directionLabel(direction: string): string {
  if (direction === 'inbound') return 'Gast';
  if (direction === 'outbound') return 'Host';
  return 'System';
}

// ISO timestamp -> "08:37" (Uhrzeit ohne Datum, fürs Alle-Feed — dort steht
// das Datum schon als Gruppen-Überschrift).
function fmtTime(iso: string | null | undefined): string {
  const s = String(iso ?? '');
  return s.length >= 16 ? s.slice(11, 16) : s;
}

// #696/#697: Task-Kürzel für Zusagen- ODER Buchungsanfrage-Task, wenn einer getrackt wird — als
// Anhängsel an die Erfolgs-Badges (die den vollen auto_reason-Text sonst nicht zeigen, siehe
// unten). #697 hängt zusätzlich die Airbnb-24h-Frist an (Berlin-Zeit), wenn gesetzt.
function taskSuffix(draft: MessageDraft): string {
  const task = draft.smarttasks_task_id ? ` · Task #${draft.smarttasks_task_id}` : '';
  const deadline = draft.platform_deadline_at ? ` · Frist ${formatBerlinDeadline(draft.platform_deadline_at)}` : '';
  return `${task}${deadline}`;
}

// #686 Nachzieh-Liste: robustes Parsen von auto_flags (JSON-Array in der DB) — ein kaputter/
// fremder Inhalt darf die Thread-Ansicht nicht mit 500 crashen lassen, sondern fällt auf []
// zurück. Rein, ohne DB-Zugriff, daher separat testbar (siehe messages.auto-send.test.ts).
export function parseAutoFlags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// Auto-Send-Gate-Ampel für Liste/Thread-Ansicht — rein (nur esc/fmtTime), keine
// DB-Zugriffe, damit sie ohne Express-Server testbar ist (siehe messages.auto-send.test.ts).
export function renderAutoBadge(draft: MessageDraft): string {
  if (draft.status === 'sent' && draft.sent_by === 'auto') {
    return `<span class="badge" style="background:var(--color-forest);color:#fff;border:none">🟢 automatisch gesendet ${esc(fmtTime(draft.sent_at))}${esc(taskSuffix(draft))}</span>`;
  }
  if (draft.auto_decision === 'wait') {
    return `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">🟡 wartet auf dich: ${esc(draft.auto_reason)}</span>`;
  }
  if (draft.auto_decision === 'auto' && draft.auto_mode === 'shadow') {
    return `<span class="badge">⚪ wäre automatisch gesendet worden${esc(taskSuffix(draft))}</span>`;
  }
  if (draft.auto_decision === 'auto' && draft.auto_mode === 'live' && draft.status === 'pending') {
    return `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">🟡 Auto-Send steht aus${esc(taskSuffix(draft))}</span>`;
  }
  return '';
}

// ISO/SQLite-Timestamp -> "YYYY-MM-DD" (Gruppierungsschlüssel je Kalendertag).
function dayKeyOf(iso: string | null | undefined): string {
  return String(iso ?? '').slice(0, 10);
}

// "YYYY-MM-DD" -> "TT.MM.JJJJ" für die Datums-Überschrift im Alle-Feed.
function dayHeading(key: string): string {
  const parts = key.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : key;
}

const SNIPPET_MAX_LEN = 140;

// Whitespace normalisiert, auf ~140 Zeichen gekürzt, escaped; leere Bodies
// (z. B. reine Anhänge) werden als "[ohne Text]" markiert.
function snippetFor(body: string | null | undefined): string {
  const normalized = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '[ohne Text]';
  const truncated = normalized.length > SNIPPET_MAX_LEN
    ? `${normalized.slice(0, SNIPPET_MAX_LEN)}…`
    : normalized;
  return esc(truncated);
}

// Chronologischer Nachrichten-Feed (nicht Thread-Liste) für die "Alle"-Ansicht:
// alle Nachrichten über alle Threads/Kanäle, neueste zuerst, nach Kalendertag
// gruppiert.
function renderFeed(rows: MessageFeedRow[]): string {
  if (!rows.length) return '<p class="empty">Keine Nachrichten in diesem Zeitraum.</p>';
  const groups = new Map<string, MessageFeedRow[]>();
  for (const row of rows) {
    const key = dayKeyOf(row.sent_at);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row); else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .map(([key, msgs]) => {
      const items = msgs
        .map((m) => {
          const property = propertyForBadge({ source: m.source, listing_id: m.listing_id });
          const code = property?.shortCode ?? property?.slug;
          const codeBadge = code
            ? `<span class="badge"${property?.uiColor ? ` style="background:${esc(property.uiColor)};color:var(--color-charcoal)"` : ''}>${esc(code)}</span>`
            : '';
          const name = esc(m.guest_name) || esc(m.thread_id);
          return `<li class="feed-row">
            <span class="feed-time">${esc(fmtTime(m.sent_at))}</span>
            ${codeBadge}
            <a href="/admin/messages/${encodeURIComponent(m.thread_id)}" class="feed-name">${name}</a>
            <span class="badge">${esc(directionLabel(m.direction))}</span>
            <span class="feed-snippet">${snippetFor(m.body)}</span>
          </li>`;
        })
        .join('');
      return `<div class="feed-day"><h3>${esc(dayHeading(key))}</h3><ul class="feed-list">${items}</ul></div>`;
    })
    .join('');
}

const ALLE_WINDOW_DAYS = 14;

// Liste offener Threads (Default) ODER chronologischer Alle-Feed (?view=alle),
// umgeschaltet per Query-Param auf derselben Route — siehe SmartTasks #409.
router.get('/', (req, res) => {
  const view = req.query.view === 'alle' ? 'alle' : 'offen';
  const threads = getThreadsNeedingReply();
  const rows = threads
    .map((t) => {
      const name = esc(t.guest_name) || esc(t.id);
      const d = getActiveDraftByThread(t.id);
      const draftBadge = d
        ? `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">${d.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'} bereit</span>`
        : '';
      const autoBadge = d ? renderAutoBadge(d) : '';
      const property = propertyForBadge(t);
      const code = property?.shortCode ?? property?.slug;
      // Objekt-Kürzel farbig (uiColor der Property), Zeile selbst bleibt neutral.
      const codeBadge = code
        ? `<span class="badge"${property?.uiColor ? ` style="background:${esc(property.uiColor)};color:var(--color-charcoal)"` : ''}>${esc(code)}</span>`
        : '';
      return `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">
        <span class="thread-name">${name}</span>
        <span class="thread-meta">${draftBadge}${autoBadge}${codeBadge}<span class="badge">${esc(t.channel)}</span><span>${esc(fmtDate(t.last_message_at))}</span></span>
      </a></li>`;
    })
    .join('');
  const offenList = threads.length
    ? `<ul class="thread-list">${rows}</ul>`
    : '<p class="empty">Keine offenen Nachrichten — alles beantwortet. 🎉</p>';

  // "Alle"-Feed-Zähler nur laden, wenn diese Ansicht auch gerendert wird —
  // spart die zusätzliche Query auf der (häufiger aufgerufenen) Offen-Seite.
  let alleCount: number | null = null;
  let mainContent: string;
  if (view === 'alle') {
    const sinceIso = new Date(Date.now() - ALLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const feedMessages = getMessagesSince(sinceIso);
    alleCount = feedMessages.length;
    mainContent = `<p class="subtitle">Alle Nachrichten der letzten ${ALLE_WINDOW_DAYS} Tage, über alle Threads und Kanäle — neueste zuerst.</p>
    <div class="section">${renderFeed(feedMessages)}</div>`;
  } else {
    mainContent = `<p class="subtitle">Threads, deren letzte Nachricht vom Gast kam und auf eine Antwort warten.</p>
    <div class="section">${offenList}</div>`;
  }

  const tabs = `<div class="tabs">
      <a href="/admin/messages" class="tab${view === 'offen' ? ' tab-active' : ''}">Offen <span class="count-pill">${threads.length} offen</span></a>
      <a href="/admin/messages?view=alle" class="tab${view === 'alle' ? ' tab-active' : ''}">Alle (${ALLE_WINDOW_DAYS} Tage)${alleCount !== null ? ` <span class="count-pill">${alleCount}</span>` : ''}</a>
    </div>`;

  const lastSync = getLastMessageSync();
  const lastSyncLabel = syncRunning
    ? 'Sync läuft …'
    : lastSync ? `Letzter Sync: ${esc(fmtDate(lastSync))}` : 'Noch nie gesynct';
  const progressLines = syncProgress.lines.map((l) => esc(l)).join('<br>');
  const syncLog = syncRunning
    ? `<div class="sync-log"><strong>Sync läuft — Fortschritt:</strong><br>${progressLines || 'Starte …'}</div>`
    : syncProgress.lines.length
      ? `<details class="sync-log"><summary>Letzter Sync-Lauf ${esc(fmtDate(syncProgress.finishedAt ?? ''))} — Details</summary>${progressLines}</details>`
      : '';
  const body = `<div class="page-head">
      <h1>Nachrichten</h1>
      <div class="sync-bar">
        <form method="POST" action="/admin/messages/sync"><button type="submit" class="btn btn-primary">Jetzt syncen</button></form>
        <span class="sync-info">${lastSyncLabel}</span>
        <a href="/admin/suggestions" class="btn btn-ghost">Vault-Vorschläge${(() => { const n = countPendingSuggestions(); return n ? ` (${n})` : ''; })()}</a>
        <a href="/admin/messages/auto-send" class="btn btn-ghost">Auto-Send</a>
      </div>
    </div>
    ${syncLog}
    ${tabs}
    ${mainContent}
    ${syncRunning ? '<script>setTimeout(() => location.reload(), 4000);</script>' : ''}`;
  res.type('html').send(renderAdminPage({ title: 'Nachrichten', body, active: 'messages' }));
});

// Auswertungsseite + Pausen-Schalter (Spec 7.1 + 9). Muss VOR '/:threadId'
// registriert werden, sonst fängt die Thread-Route "auto-send" als threadId ab.
router.get('/auto-send', (_req, res) => {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const s = getAutoSendStats(since30);
  const n = (v: number | null) => v ?? 0;
  const paused = getSchedulerState(PAUSE_KEY) === '1';
  const rate = n(s.shadowUnchanged) + n(s.shadowChanged) > 0
    ? Math.round(100 * n(s.shadowUnchanged) / (n(s.shadowUnchanged) + n(s.shadowChanged)))
    : null;
  const todayCount = countAutoSentSince(startOfBerlinDayIso());
  const rows = listAutoDecisions(100).map((d) => `<tr>
      <td>${esc(fmtDate(d.created_at))}</td><td><a href="/admin/messages/${encodeURIComponent(d.thread_id)}">${esc(d.guest_name) || esc(d.thread_id)}</a></td>
      <td>${esc(d.auto_mode)}</td><td>${esc(d.auto_decision)}</td><td>${esc(d.auto_category ?? '')}</td><td>${esc(d.auto_reason)}</td>
      <td>${d.status === 'sent' ? (d.sent_by === 'auto' ? 'auto' : d.sent_body_changed ? 'Micha, geändert' : 'Micha, unverändert') : esc(d.status)}</td></tr>`).join('');
  const body = `<a class="back-link" href="/admin/messages">&larr; Nachrichten</a>
    <h1>Auto-Send</h1>
    <div class="section">
      <form method="POST" action="/admin/messages/auto-send/pause"><input type="hidden" name="paused" value="${paused ? 0 : 1}">
        <button type="submit" class="btn ${paused ? 'btn-primary' : 'btn-danger'}">${paused ? 'Auto-Send fortsetzen' : 'Auto-Send pausieren'}</button></form>
      <p class="subtitle">Env-Modus: <strong>${esc(config.autoSendMode)}</strong> · heute automatisch gesendet: ${todayCount}/${config.autoSendDailyCap}${paused ? ' · <strong>PAUSIERT</strong>' : ''}</p>
    </div>
    <div class="section"><h3>Letzte 30 Tage</h3>
      <p>Automatisch gesendet: <strong>${n(s.autoSent)}</strong> · warteten auf dich: <strong>${n(s.waited)}</strong></p>
      <p>Schatten: <strong>${n(s.shadowWouldAuto)}</strong> wären automatisch rausgegangen — davon von dir unverändert gesendet: <strong>${n(s.shadowUnchanged)}</strong>, geändert: <strong>${n(s.shadowChanged)}</strong>, verworfen: <strong>${n(s.shadowDiscarded)}</strong>
      ${rate !== null ? ` → <strong>${rate} % unverändert</strong> (Ziel ≥ 95 % bei ≥ 20 Fällen)` : ''}</p>
    </div>
    <div class="section" style="overflow-x:auto">
      <style>.auto-send-table{width:100%;border-collapse:collapse;font-size:13px}
        .auto-send-table th,.auto-send-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--color-stone);vertical-align:top}
        .auto-send-table th{color:var(--color-warm-gray);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.04em}</style>
      <table class="auto-send-table"><thead><tr><th>Zeit</th><th>Gast</th><th>Modus</th><th>Entscheidung</th><th>Kategorie</th><th>Grund</th><th>Ausgang</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  res.type('html').send(renderAdminPage({ title: 'Auto-Send', body, active: 'messages' }));
});

router.post('/auto-send/pause', express.urlencoded({ extended: true }), (req, res) => {
  setSchedulerState(PAUSE_KEY, req.body?.paused === '1' ? '1' : '0');
  res.redirect('/admin/messages/auto-send');
});

// Thread-Detail + Draft-Formular
router.get('/:threadId', (req, res) => {
  const thread = getThreadById(req.params.threadId);
  if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
  const msgs = getMessagesByThread(thread.id);
  const draft = getActiveDraftByThread(thread.id);
  // Ohne aktiven Draft: den zuletzt gesendeten heranziehen, damit das grüne
  // "automatisch gesendet"-Badge auch nach dem Versand sichtbar bleibt.
  const lastSent = draft ? null : getLastSentDraftByThread(thread.id);
  // Guesty: Senden nur, wenn der Kanal der letzten Gastnachricht spiegelbar ist.
  const canSend = thread.source !== 'guesty' || resolveOutboundModuleType(msgs) !== null;
  // Das Modell hat für den aktuellen Stand entschieden: keine Antwort nötig → Button ausgrauen.
  const aiSaysNoReply = !!thread.ai_no_reply_at
    && parseUtc(thread.ai_no_reply_at) >= parseUtc(thread.last_message_at);
  const property = propertyForBadge(thread);
  const name = esc(thread.guest_name) || esc(thread.id);
  const history = msgs
    .map((m) =>
      `<div class="msg ${esc(m.direction)}">
        <div class="meta">${esc(directionLabel(m.direction))} · ${esc(fmtDate(m.sent_at))}</div>
        <div class="body">${esc(m.body)}</div>
      </div>`,
    )
    .join('');

  const autoPanel = draft?.auto_decision
    ? `<div class="section" style="border-left:4px solid var(--color-amber)">
         <strong>Auto-Send-Gate</strong> · Modus ${esc(draft.auto_mode)} · ${renderAutoBadge(draft)}
         <p class="subtitle" style="margin:6px 0 0">Kategorie: ${esc(draft.auto_category ?? '–')} · Flags: ${esc(parseAutoFlags(draft.auto_flags).join(', ') || 'keine')}<br>${esc(draft.auto_reason)}</p>
         ${draft.auto_mode === 'shadow' ? '<p class="subtitle">Schattenphase — nichts wird ohne dich gesendet.</p>' : ''}
       </div>`
    : lastSent?.sent_by === 'auto'
      ? `<div class="section" style="border-left:4px solid var(--color-forest)">
           <strong>Auto-Send-Gate</strong> · ${renderAutoBadge(lastSent)}
           <p class="subtitle" style="margin:6px 0 0">Grund: ${esc(lastSent.auto_reason)}</p>
         </div>`
      : '';

  const canSendHint = '<p class="subtitle">Kanal unklar — bitte direkt in der Guesty-Inbox antworten.</p>';
  const draftBlock = draft
    ? `<h3>${draft.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'}</h3>
       ${canSend
         ? `<form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
              <textarea name="body" rows="7">${esc(draft.body)}</textarea>
              <div class="actions"><button type="submit" class="btn btn-primary">Senden (Freigabe)</button></div>
            </form>`
         : `<textarea rows="7" readonly>${esc(draft.body)}</textarea>
            ${canSendHint}`}
       <div class="actions">
         ${draft.generated_by === 'llm' ? `<form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/regenerate"><button type="submit" class="btn btn-ghost">Neu generieren</button></form>` : ''}
         <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/discard">
           <button type="submit" class="btn btn-danger">Verwerfen</button></form>
       </div>
       <details style="margin-top:16px">
         <summary style="cursor:pointer;color:var(--color-warm-gray)">Passt nicht? Feedback geben</summary>
         <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/feedback" style="margin-top:12px">
           <select name="category" class="badge" style="padding:6px 10px">
             <option value="ton">Ton/Voice</option>
             <option value="fakt">Objektfakt</option>
             <option value="einmalig">Einmalig</option>
           </select>
           <textarea name="note" rows="3" required placeholder="Was stört dich?" style="margin-top:10px"></textarea>
           <div class="actions"><button type="submit" class="btn btn-ghost">Feedback senden</button></div>
         </form>
       </details>`
    : `<h3>Antwort verfassen</h3>
       ${['hostex', 'guesty'].includes(thread.source)
         ? aiSaysNoReply
           ? `<div class="actions" style="margin-bottom:16px;align-items:center">
                <button type="button" class="btn btn-ghost" disabled style="opacity:0.5;cursor:not-allowed">KI-Entwurf generieren</button>
                <span class="subtitle" style="margin:0">KI sieht aktuell keine Antwort nötig</span>
              </div>`
           : `<div class="actions" style="margin-bottom:16px">
                <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/regenerate">
                  <button type="submit" class="btn btn-primary">KI-Entwurf generieren</button></form>
              </div>`
         : ''}
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/reply">
         <textarea name="body" rows="6" required placeholder="Antwort an ${name} …"></textarea>
         <div class="actions">
           ${canSend ? '<button type="submit" class="btn btn-primary">Senden</button>' : ''}
           <button type="submit" formaction="/admin/messages/${encodeURIComponent(thread.id)}/draft" class="btn btn-ghost">Als Entwurf speichern</button>
         </div>
       </form>
       ${canSend ? '' : canSendHint}`;

  const noDraftNotice = req.query.nodraft === '1'
    ? `<p class="subtitle" style="background:var(--color-sand);padding:10px 14px;border-radius:8px">
         Die KI hat bewusst keinen Entwurf erstellt — die letzte Gastnachricht braucht aus ihrer
         Sicht keine Antwort (z.&nbsp;B. reines Danke/Bestätigung). Bei Bedarf unten manuell schreiben.
       </p>`
    : '';
  const genFailedNotice = req.query.genfailed === '1'
    ? `<p class="subtitle" style="background:var(--color-sand);padding:10px 14px;border-radius:8px">
         Die KI-Generierung ist technisch fehlgeschlagen (kein verwertbarer Output) — das ist KEINE
         Entscheidung, dass keine Antwort nötig ist. Bitte nochmal „Neu generieren" versuchen oder
         unten manuell schreiben.
       </p>`
    : '';
  const sendBlockedNotice = req.query.sendblocked === '1'
    ? `<p class="subtitle" style="background:var(--color-sand);padding:10px 14px;border-radius:8px">
         Kanal unklar — bitte direkt in der Guesty-Inbox antworten.
       </p>`
    : '';
  const draftExistsNotice = req.query.draftexists === '1'
    ? `<p class="subtitle" style="background:var(--color-sand);padding:10px 14px;border-radius:8px">
         Es existiert bereits ein offener Entwurf für diesen Thread — der neue Text wurde nicht
         gesendet. Bitte den bestehenden Entwurf unten senden oder verwerfen.
       </p>`
    : '';
  const sentNotice = req.query.sent === '1'
    ? `<p class="subtitle" style="background:var(--color-sand);padding:10px 14px;border-radius:8px;border-left:4px solid var(--color-forest)">
         Nachricht gesendet.
       </p>`
    : '';
  const body = `<a class="back-link" href="/admin/messages">&larr; Alle Nachrichten</a>
    <h1>${name}</h1>
    <p class="subtitle"><span class="badge">${esc(thread.channel)}</span>${property ? ` · <strong>${esc(property.name)}</strong>` : ''} · Provider: ${esc(thread.source)}</p>
    <div class="section"><h3>Verlauf</h3>${history}</div>
    ${autoPanel}
    <div class="section">${noDraftNotice}${genFailedNotice}${sendBlockedNotice}${draftExistsNotice}${sentNotice}${draftBlock}</div>`;
  res.type('html').send(renderAdminPage({ title: name, body, active: 'messages' }));
});

// Draft anlegen (manuell)
router.post('/:threadId/draft', express.urlencoded({ extended: true }), (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
    const body = String((req.body?.body ?? '')).trim();
    if (!body) { res.status(400).send('Leerer Entwurf'); return; }
    if (getActiveDraftByThread(thread.id)) { res.status(409).send('Es existiert bereits ein offener Entwurf'); return; }
    createDraft({
      id: randomUUID(), thread_id: thread.id,
      provider: thread.source === 'guesty' ? 'guesty' : 'hostex',
      body, generated_by: 'manual',
    });
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});

// Freigabe: senden
router.post('/drafts/:draftId/send', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const draft = getDraftById(req.params.draftId);
    if (!draft) { res.status(404).send('Entwurf nicht gefunden'); return; }
    const thread = getThreadById(draft.thread_id);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }

    // Atomic send guard: claim the draft transitioning pending→sending.
    // Two concurrent POST requests both pass the draft/thread existence checks above,
    // but only ONE can win the UPDATE WHERE status='pending' race — the other gets false
    // and is rejected with 409. This eliminates the TOCTOU double-send window.
    if (!claimDraftForSending(draft.id)) {
      res.status(409).send('Entwurf ist nicht mehr offen oder wird bereits gesendet');
      return;
    }

    const edited = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (edited && edited !== draft.body) updateDraftBody(draft.id, edited);
    const bodyToSend = edited || draft.body;

    setSentBodyChanged(draft.id, edited !== '' && edited !== draft.body);
    const result = await sendClaimedDraft(draft.id, thread, bodyToSend, 'micha');
    if (result.ok) {
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
    } else {
      res.status(502).send(`Versand fehlgeschlagen: ${esc(String(result.err))}`);
    }
  } catch (e) { next(e); }
});

// Direkt-Senden ohne Zwei-Schritt-Freigabe (SmartTasks #409, Nachschärfung): Micha tippt selbst —
// sein Klick IST die Freigabe. Läuft trotzdem über dieselbe Draft-Infrastruktur (Audit-Trail,
// claimDraftForSending-Guard, sendClaimedDraft) wie der KI-Entwurf-Pfad, nur ohne Zwischenstopp.
router.post('/:threadId/reply', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) { res.status(400).send('Leere Antwort'); return; }
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }

    // Guesty: Senden nur, wenn der Kanal der letzten Gastnachricht spiegelbar ist (wie im GET).
    const canSend = thread.source !== 'guesty' || resolveOutboundModuleType(getMessagesByThread(thread.id)) !== null;
    if (!canSend) {
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}?sendblocked=1`);
      return;
    }

    // Es existiert bereits ein offener Entwurf → nicht anfassen, keinen zweiten anlegen.
    if (getActiveDraftByThread(thread.id)) {
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}?draftexists=1`);
      return;
    }

    const draftId = randomUUID();
    createDraft({
      id: draftId, thread_id: thread.id,
      provider: thread.source === 'guesty' ? 'guesty' : 'hostex',
      body, generated_by: 'manual',
    });
    if (!claimDraftForSending(draftId)) {
      // Praktisch nie erreichbar (Draft wurde gerade erst pending angelegt) — defensiv wie
      // beim Freigabe-Send behandelt.
      res.status(409).send('Entwurf ist nicht mehr offen oder wird bereits gesendet');
      return;
    }

    const result = await sendClaimedDraft(draftId, thread, body, 'micha');
    if (result.ok) {
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}?sent=1`);
    } else {
      res.status(502).send(`Versand fehlgeschlagen: ${esc(String(result.err))}`);
    }
  } catch (e) { next(e); }
});

// Verwerfen — heißt verwerfen (SmartTasks #497): der Thread bleibt draftlos.
// Ohne den markThreadDiscarded-Marker würde der nächste Cron-/Sync-Lauf
// (generateDraftsForProperty -> getThreadsNeedingDraft) den Thread sofort
// wieder bedraften, weil dort nur "kein pending-Draft" geprüft wird — das
// unterscheidet nicht zwischen "noch nie gedraftet" und "Mensch hat bewusst
// verworfen" (häufigster Grund laut Micha: zeitkritischer Entwurf, z.B. "gute
// Heimreise", nicht mehr rechtzeitig abgeschickt). Ein neuer Entwurf entsteht
// danach nur noch durch eine neue Gastnachricht (invalidiert den Marker
// implizit, siehe getThreadsNeedingDraft) oder den expliziten
// "Neu generieren"-Button (POST /:threadId/regenerate, umgeht die Query ganz).
router.post('/drafts/:draftId/discard', (req, res, next) => {
  try {
    const draft = getDraftById(req.params.draftId);
    if (!draft) { res.status(404).send('Entwurf nicht gefunden'); return; }
    discardDraft(draft.id);
    markThreadDiscarded(draft.thread_id);
    res.redirect(`/admin/messages/${encodeURIComponent(draft.thread_id)}`);
  } catch (e) { next(e); }
});

// Neu generieren: aktiven Entwurf verwerfen, frischen KI-Entwurf erzeugen (nur Hostex)
router.post('/:threadId/regenerate', async (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
    if (!['hostex', 'guesty'].includes(thread.source) || !thread.listing_id) {
      res.status(400).send('Neu generieren ist nur für Hostex-/Guesty-Threads verfügbar'); return;
    }
    const property = getPropertyForThread(thread);
    const voice = loadVoice();
    const facts = property?.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
    if (!voice || !facts) { res.status(400).send('Kein Vault-Wissen verfügbar (VAULT_PATH/vaultNote prüfen)'); return; }

    const messages = getMessagesByThread(thread.id);
    const result = await generateDraftForThread({
      thread, messages, voice, facts,
      bookingContext: buildBookingContext(thread),
      // #697: manuelles Neu-Generieren bekommt denselben Buchungsanfrage-Prompt wie der
      // automatische Pfad — sonst würde ein manueller Regenerate für eine Buchungsanfrage
      // fälschlich den normalen Antwort-Prompt bekommen. Task-Anlage/Frist laufen hier NICHT
      // (kein Gate-Aufruf auf diesem Pfad, wie bisher — Micha prüft den Entwurf ohnehin von Hand).
      isBookingRequest: detectBookingRequestContext(messages) !== null,
    });
    let redirectSuffix = '';
    if (result.kind === 'text') {
      const existing = getActiveDraftByThread(thread.id);
      if (existing) discardDraft(existing.id);
      createDraft({ id: randomUUID(), thread_id: thread.id, provider: thread.source as 'hostex' | 'guesty', body: result.body, generated_by: 'llm', model: DRAFT_MODEL });
    } else if (result.kind === 'no_reply') {
      // Bewusste Modell-Entscheidung (keine Antwort nötig) — merken (graut den Button aus,
      // verhindert erneute Cron-LLM-Calls) + Hinweis anzeigen.
      logger.info({ threadId: thread.id, reason: result.reason }, 'regenerate: no reply needed');
      markThreadAiNoReply(thread.id);
      redirectSuffix = '?nodraft=1';
    } else {
      // Technischer Ausfall — NICHT markThreadAiNoReply (#385), sonst wäre der Thread
      // dauerhaft von weiteren Versuchen ausgeschlossen. Eigener Hinweis in der UI.
      logger.warn({ threadId: thread.id, error: result.error }, 'regenerate: thread failed (technical)');
      redirectSuffix = '?genfailed=1';
    }
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}${redirectSuffix}`);
  } catch (e) { next(e); }
});

// Runs in the background so the HTTP request returns immediately (the full sync can
// take a while — it fetches conversation details — and would otherwise risk a proxy timeout).
// Process-scoped; correct for single-instance PM2. Cluster mode would need a shared lock.
let syncRunning = false;

// Menschlich lesbarer Fortschritt des letzten/laufenden Sync-Laufs — wird von der
// Threadliste angezeigt (live via 4s-Auto-Reload, danach als aufklappbare Zusammenfassung).
const syncProgress: { startedAt: string | null; finishedAt: string | null; lines: string[] } = {
  startedAt: null,
  finishedAt: null,
  lines: [],
};

// Exportiert für Tests (Final-Review F2): direkter Aufruf statt über den asynchron
// feuernden POST /sync-Handler, der sofort redirectet und kein Fertig-Signal liefert.
export async function runMessageSync(): Promise<void> {
  syncProgress.startedAt = new Date().toISOString();
  syncProgress.finishedAt = null;
  syncProgress.lines = [];
  const log = (line: string) => { syncProgress.lines.push(line); };
  // Gemeinsamer Lock mit Loop/Webhook (Spec 3.1/3.2) — ein manueller Anstoß darf sich
  // nicht mit einem laufenden Sync überschneiden.
  if (!(await acquireMessageSyncLock('manual', 30_000))) {
    log('Sync läuft bereits (Loop/ETL) — bitte gleich erneut');
    syncProgress.finishedAt = new Date().toISOString();
    return;
  }
  // Final-Review F2: getHostexClient() (und alles danach) MUSS im try stehen — wirft
  // es (z. B. fehlender Hostex-Token), lief das finally sonst nie und der Lock blieb
  // für immer belegt (Loop/ETL/Button übersprangen jeden weiteren Lauf).
  try {
    const client = getHostexClient();
    // One shared detail cache across all property passes → each conversation detail
    // (esp. empty-title inquiries) is fetched at most once per run.
    const detailCache = new Map<string, HostexConversationDetail>();
    for (const property of getPropertiesByProvider('hostex')) {
      log(`Hostex · ${property.name}: Nachrichten syncen …`);
      const r = await syncHostexMessagesForProperty(property, client, undefined, detailCache);
      log(r.success
        ? `Hostex · ${property.name}: ${r.threads} aktualisiert, ${r.skippedUnchanged} unverändert übersprungen ✓`
        : `Hostex · ${property.name}: FEHLER — ${r.error}`);
      const d = await generateDraftsForProperty(property);
      if (d.generated > 0) log(`Hostex · ${property.name}: ${d.generated} KI-Entwurf/-Entwürfe neu`);
    }
    const guestyProps = getPropertiesByProvider('guesty');
    if (guestyProps.length > 0) {
      log('Guesty: Conversation-Liste laden …');
      const conversations = await fetchAllConversations(); // account-weit: EIN Fetch pro Run
      log(`Guesty: ${conversations.length} Conversations geladen`);
      for (const property of guestyProps) {
        log(`Guesty · ${property.name}: Nachrichten syncen …`);
        const r = await syncGuestyMessagesForProperty(property, conversations);
        log(r.success
          ? `Guesty · ${property.name}: ${r.threadsForProperty - r.skippedUnchanged} aktualisiert, ${r.skippedUnchanged} unverändert übersprungen (${(r.durationMs / 1000).toFixed(1)}s) ✓`
          : `Guesty · ${property.name}: FEHLER — ${r.error}`);
        const d = await generateDraftsForProperty(property);
        if (d.generated > 0) log(`Guesty · ${property.name}: ${d.generated} KI-Entwurf/-Entwürfe neu`);
      }
    }
    log('Fertig.');
  } finally {
    syncProgress.finishedAt = new Date().toISOString();
    messageSyncLock.release('manual');
  }
}

// Nachrichten jetzt syncen (asynchron): startet den Lauf und leitet sofort zurück.
router.post('/sync', (_req, res) => {
  if (!syncRunning) {
    syncRunning = true;
    runMessageSync()
      .catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'message sync (button) failed'))
      .finally(() => { syncRunning = false; });
  }
  res.redirect('/admin/messages');
});

// Feedback zu einem Entwurf: erfassen und (Ton/Fakt) einen Vault-Vorschlag generieren.
router.post('/:threadId/feedback', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
    const category = String(req.body?.category ?? '');
    const note = String(req.body?.note ?? '').trim();
    if (!['ton', 'fakt', 'einmalig'].includes(category) || !note) { res.status(400).send('Kategorie + Notiz nötig'); return; }

    const draft = getActiveDraftByThread(thread.id);
    const feedbackId = randomUUID();
    createFeedback({ id: feedbackId, thread_id: thread.id, draft_id: draft?.id ?? null, category: category as 'ton' | 'fakt' | 'einmalig', note });

    if (category !== 'einmalig') {
      const isTon = category === 'ton';
      const property = isTon ? null : getPropertyForThread(thread);
      const targetFile = isTon
        ? 'prozesse/Gästekommunikation Grundsätze.md'
        : property?.vaultNote ? `prozesse/${property.vaultNote}` : null;
      const fileContent = isTon ? loadVoice() : property?.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
      if (targetFile && fileContent) {
        try {
          const proposal = await generateSuggestion(
            { category: category as 'ton' | 'fakt', note, draftBody: draft?.body ?? '', fileContent },
          );
          if (proposal) {
            createSuggestion({
              id: randomUUID(), feedback_id: feedbackId, target_file: targetFile,
              target_heading: proposal.target_heading, addition_text: proposal.addition_text, rationale: proposal.rationale,
            });
            res.redirect('/admin/suggestions');
            return;
          }
        } catch (llmErr) {
          logger.error({ err: llmErr instanceof Error ? llmErr.message : String(llmErr) }, 'generateSuggestion failed; feedback recorded, degrading gracefully');
        }
      }
    }
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});

export default router;
