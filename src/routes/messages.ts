// src/routes/messages.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  getThreadsNeedingReply, getThreadById, getMessagesByThread, upsertMessage,
} from '../repositories/message-repository.js';
import {
  createDraft, getDraftById, getActiveDraftByThread, markDraftSent, markDraftError, discardDraft,
  claimDraftForSending,
} from '../repositories/draft-repository.js';
import { sendReply } from '../services/message-sender.js';
import { renderAdminPage } from './admin-layout.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
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

// Liste offener Threads
router.get('/', (_req, res) => {
  const threads = getThreadsNeedingReply();
  const rows = threads
    .map((t) => {
      const name = esc(t.guest_name) || esc(t.id);
      return `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">
        <span class="thread-name">${name}</span>
        <span class="thread-meta"><span class="badge">${esc(t.channel)}</span><span>${esc(fmtDate(t.last_message_at))}</span></span>
      </a></li>`;
    })
    .join('');
  const list = threads.length
    ? `<ul class="thread-list">${rows}</ul>`
    : '<p class="empty">Keine offenen Nachrichten — alles beantwortet. 🎉</p>';
  const body = `<h1>Nachrichten <span class="count-pill">${threads.length} offen</span></h1>
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
    ? `<h3>Entwurf</h3>
       <div class="draft-preview">${esc(draft.body)}</div>
       <div class="actions">
         <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
           <button type="submit" class="btn btn-primary">Senden (Freigabe)</button></form>
         <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/discard">
           <button type="submit" class="btn btn-danger">Verwerfen</button></form>
       </div>`
    : `<h3>Antwort verfassen</h3>
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/draft">
         <textarea name="body" rows="6" required placeholder="Antwort an ${name} …"></textarea>
         <div class="actions"><button type="submit" class="btn btn-primary">Entwurf speichern</button></div>
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
router.post('/drafts/:draftId/send', async (req, res, next) => {
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

    try {
      const { externalMessageId } = await sendReply(thread, draft.body);
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
        subject: null, body: draft.body, body_html: null, source: thread.source,
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

export default router;
