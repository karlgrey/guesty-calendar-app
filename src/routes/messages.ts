// src/routes/messages.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  getThreadsNeedingReply, getThreadById, getMessagesByThread, upsertMessage,
} from '../repositories/message-repository.js';
import {
  createDraft, getDraftById, getActiveDraftByThread, markDraftSent, markDraftError, discardDraft,
} from '../repositories/draft-repository.js';
import { sendReply } from '../services/message-sender.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Liste offener Threads
router.get('/', (_req, res) => {
  const threads = getThreadsNeedingReply();
  const rows = threads.map((t) =>
    `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">${esc(t.guest_name) || esc(t.id)}</a>
     — ${esc(t.channel)} — ${esc(t.last_message_at)}</li>`,
  ).join('');
  res.type('html').send(`<h1>Offene Nachrichten (${threads.length})</h1><ul>${rows}</ul>`);
});

// Thread-Detail + Draft-Formular
router.get('/:threadId', (req, res) => {
  const thread = getThreadById(req.params.threadId);
  if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
  const msgs = getMessagesByThread(thread.id);
  const draft = getActiveDraftByThread(thread.id);
  const history = msgs.map((m) =>
    `<div class="${m.direction}"><b>${esc(m.direction)}</b> ${esc(m.sent_at)}<br>${esc(m.body)}</div>`,
  ).join('<hr>');

  const draftBlock = draft
    ? `<h3>Entwurf</h3><pre>${esc(draft.body)}</pre>
       <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
         <button type="submit">Senden (Freigabe)</button></form>
       <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/discard">
         <button type="submit">Verwerfen</button></form>`
    : `<h3>Antwort verfassen</h3>
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/draft">
         <textarea name="body" rows="6" cols="60" required></textarea><br>
         <button type="submit">Entwurf speichern</button></form>`;

  res.type('html').send(
    `<a href="/admin/messages">&larr; zurück</a>
     <h1>${esc(thread.guest_name) || esc(thread.id)}</h1>
     <p>Kanal: ${esc(thread.channel)} — Provider: ${esc(thread.source)}</p>
     ${history}<hr>${draftBlock}`,
  );
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
    if (draft.status !== 'pending') { res.status(409).send('Entwurf ist nicht mehr offen'); return; }
    const thread = getThreadById(draft.thread_id);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }

    try {
      const { externalMessageId } = await sendReply(thread, draft.body);
      markDraftSent(draft.id, externalMessageId);
      upsertMessage({
        id: `sent:${draft.id}`, thread_id: thread.id, direction: 'outbound',
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
