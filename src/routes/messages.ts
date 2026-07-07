// src/routes/messages.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  getThreadsNeedingReply, getThreadById, getMessagesByThread, upsertMessage,
  getLastHostexMessageSync,
} from '../repositories/message-repository.js';
import {
  createDraft, getDraftById, getActiveDraftByThread, markDraftSent, markDraftError, discardDraft,
  claimDraftForSending, updateDraftBody,
} from '../repositories/draft-repository.js';
import { getPropertyByHostexId, getPropertyByGuestyId, getPropertiesByProvider, type PropertyConfig } from '../config/properties.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread, DRAFT_MODEL } from '../services/draft-service.js';
import { sendReply } from '../services/message-sender.js';
import { getHostexClient, type HostexConversationDetail } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from '../jobs/hostex/sync-hostex-messages.js';
import { generateDraftsForProperty } from '../jobs/generate-drafts.js';
import logger from '../utils/logger.js';
import { renderAdminPage } from './admin-layout.js';
import { createFeedback, createSuggestion, countPendingSuggestions } from '../repositories/feedback-repository.js';
import { generateSuggestion } from '../services/suggestion-service.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// ISO timestamp -> "2026-06-29 08:37" (trim seconds/timezone for readability).
function fmtDate(iso: string | null | undefined): string {
  const s = String(iso ?? '');
  return s.length >= 16 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s;
}

// Provider-aware property lookup: threads store the provider-native listing id.
function getPropertyForThread(thread: { source: string; listing_id: string | null }): PropertyConfig | undefined {
  if (!thread.listing_id) return undefined;
  if (thread.source === 'hostex') return getPropertyByHostexId(thread.listing_id);
  if (thread.source === 'guesty') return getPropertyByGuestyId(thread.listing_id);
  return undefined;
}

function directionLabel(direction: string): string {
  if (direction === 'inbound') return 'Gast';
  if (direction === 'outbound') return 'Host';
  return 'System';
}

// Liste offener Threads
router.get('/', (_req, res) => {
  const threads = getThreadsNeedingReply();
  const rows = threads
    .map((t) => {
      const name = esc(t.guest_name) || esc(t.id);
      const d = getActiveDraftByThread(t.id);
      const draftBadge = d
        ? `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">${d.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'} bereit</span>`
        : '';
      return `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">
        <span class="thread-name">${name}</span>
        <span class="thread-meta">${draftBadge}<span class="badge">${esc(t.channel)}</span><span>${esc(fmtDate(t.last_message_at))}</span></span>
      </a></li>`;
    })
    .join('');
  const list = threads.length
    ? `<ul class="thread-list">${rows}</ul>`
    : '<p class="empty">Keine offenen Nachrichten — alles beantwortet. 🎉</p>';
  const lastSync = getLastHostexMessageSync();
  const lastSyncLabel = syncRunning
    ? 'Sync läuft …'
    : lastSync ? `Letzter Sync: ${esc(fmtDate(lastSync))}` : 'Noch nie gesynct';
  const body = `<div class="page-head">
      <h1>Nachrichten <span class="count-pill">${threads.length} offen</span></h1>
      <div class="sync-bar">
        <form method="POST" action="/admin/messages/sync"><button type="submit" class="btn btn-primary">Jetzt syncen</button></form>
        <span class="sync-info">${lastSyncLabel}</span>
        <a href="/admin/suggestions" class="btn btn-ghost">Vault-Vorschläge${(() => { const n = countPendingSuggestions(); return n ? ` (${n})` : ''; })()}</a>
      </div>
    </div>
    <p class="subtitle">Threads, deren letzte Nachricht vom Gast kam und auf eine Antwort warten.</p>
    <div class="section">${list}</div>`;
  res.type('html').send(renderAdminPage({ title: 'Nachrichten', body }));
});

// Thread-Detail + Draft-Formular
router.get('/:threadId', (req, res) => {
  const thread = getThreadById(req.params.threadId);
  if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
  const msgs = getMessagesByThread(thread.id);
  const draft = getActiveDraftByThread(thread.id);
  const name = esc(thread.guest_name) || esc(thread.id);
  const history = msgs
    .map((m) =>
      `<div class="msg ${esc(m.direction)}">
        <div class="meta">${esc(directionLabel(m.direction))} · ${esc(fmtDate(m.sent_at))}</div>
        <div class="body">${esc(m.body)}</div>
      </div>`,
    )
    .join('');

  const draftBlock = draft
    ? `<h3>${draft.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'}</h3>
       <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
         <textarea name="body" rows="7">${esc(draft.body)}</textarea>
         <div class="actions"><button type="submit" class="btn btn-primary">Senden (Freigabe)</button></div>
       </form>
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
       ${thread.source === 'hostex'
         ? `<div class="actions" style="margin-bottom:16px">
              <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/regenerate">
                <button type="submit" class="btn btn-primary">KI-Entwurf generieren</button></form>
            </div>`
         : ''}
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/draft">
         <textarea name="body" rows="6" required placeholder="Antwort an ${name} …"></textarea>
         <div class="actions"><button type="submit" class="btn ${thread.source === 'hostex' ? 'btn-ghost' : 'btn-primary'}">Manuell speichern</button></div>
       </form>`;

  const body = `<a class="back-link" href="/admin/messages">&larr; Alle Nachrichten</a>
    <h1>${name}</h1>
    <p class="subtitle"><span class="badge">${esc(thread.channel)}</span> · Provider: ${esc(thread.source)}</p>
    <div class="section"><h3>Verlauf</h3>${history}</div>
    <div class="section">${draftBlock}</div>`;
  res.type('html').send(renderAdminPage({ title: name, body }));
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

    try {
      const { externalMessageId } = await sendReply(thread, bodyToSend);
      markDraftSent(draft.id, externalMessageId);
      // Key the local outbound row on the returned external id so the next sync that ingests
      // the same message as hostex:{realId} hits the same row (upsert = no-op) instead of
      // creating a duplicate. Falls back to sent:{draftId} when no external id is returned.
      // NOTE: this collapse assumes the send response's message_id equals the id the
      // conversation later reports; confirm on first live send.
      const outboundId = externalMessageId ? `hostex:${externalMessageId}` : `sent:${draft.id}`;
      upsertMessage({
        id: outboundId, thread_id: thread.id, direction: 'outbound',
        sent_at: new Date().toISOString(), from_name: 'host', from_address: null, to_address: null,
        subject: null, body: bodyToSend, body_html: null, source: thread.source,
        raw_meta: JSON.stringify({ draftId: draft.id, externalMessageId }),
      });
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
    } catch (sendErr) {
      markDraftError(draft.id, sendErr instanceof Error ? sendErr.message : String(sendErr));
      res.status(502).send(`Versand fehlgeschlagen: ${esc(String(sendErr))}`);
    }
  } catch (e) { next(e); }
});

// Verwerfen
router.post('/drafts/:draftId/discard', (req, res, next) => {
  try {
    const draft = getDraftById(req.params.draftId);
    if (!draft) { res.status(404).send('Entwurf nicht gefunden'); return; }
    discardDraft(draft.id);
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

    const reply = await generateDraftForThread({ thread, messages: getMessagesByThread(thread.id), voice, facts });
    if (reply) {
      const existing = getActiveDraftByThread(thread.id);
      if (existing) discardDraft(existing.id);
      createDraft({ id: randomUUID(), thread_id: thread.id, provider: thread.source as 'hostex' | 'guesty', body: reply, generated_by: 'llm', model: DRAFT_MODEL });
    }
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});

// Runs in the background so the HTTP request returns immediately (the full sync can
// take a while — it fetches conversation details — and would otherwise risk a proxy timeout).
// Process-scoped; correct for single-instance PM2. Cluster mode would need a shared lock.
let syncRunning = false;

async function runMessageSync(): Promise<void> {
  const client = getHostexClient();
  // One shared detail cache across all property passes → each conversation detail
  // (esp. empty-title inquiries) is fetched at most once per run.
  const detailCache = new Map<string, HostexConversationDetail>();
  for (const property of getPropertiesByProvider('hostex')) {
    await syncHostexMessagesForProperty(property, client, undefined, detailCache);
    await generateDraftsForProperty(property);
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
