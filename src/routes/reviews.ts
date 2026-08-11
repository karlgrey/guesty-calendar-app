// src/routes/reviews.ts
//
// Admin UI for auto-generated guest-review drafts (#377) — same Freigabe-Gate
// pattern as /admin/messages (src/routes/messages.ts): the LLM never posts
// anything, it only prepares text for Micha to copy onto the platform (no
// direct-posting API exists for either Guesty or Hostex reviews — see the
// #377 build report). Mounted at /admin/reviews in src/app.ts.
import express from 'express';
import { getOpenReviewDrafts, getReviewDraftById, markReviewDraftDone, discardReviewDraft, setReviewDraftContent } from '../repositories/review-draft-repository.js';
import { getReservationById } from '../repositories/reservation-repository.js';
import { getThreadsByReservationId, getThreadsByListingAndGuestName, getMessagesByThread } from '../repositories/message-repository.js';
import { getPropertyForThread } from '../utils/thread-property.js';
import { loadVoice } from '../services/vault-knowledge.js';
import { generateReviewForStay, REVIEW_MODEL } from '../services/review-draft-service.js';
import { classifyStayForReview } from '../utils/review-classifier.js';
import { renderAdminPage } from './admin-layout.js';
import type { ReviewDraft } from '../types/reviews.js';
import logger from '../utils/logger.js';

const router = express.Router();

const REVIEW_DEADLINE_DAYS = 14; // Airbnb: host review window closes 14 days after checkout.

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function deadline(checkOut: string): { label: string; expired: boolean } {
  const d = new Date(`${checkOut.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + REVIEW_DEADLINE_DAYS);
  const expired = d.getTime() < Date.now();
  const label = d.toISOString().slice(0, 10).split('-').reverse().join('.');
  return { label, expired };
}

function badgeFor(draft: Pick<ReviewDraft, 'provider' | 'listing_id'>) {
  const property = getPropertyForThread({ source: draft.provider, listing_id: draft.listing_id });
  const code = property?.shortCode ?? property?.slug;
  return { property, code };
}

// Gather the guest conversation for a reservation (source-aware — Hostex has
// no reservation_id on threads, see getThreadsByListingAndGuestName's docstring).
function gatherMessages(provider: 'hostex' | 'guesty', listingId: string, reservationId: string, guestName: string | null) {
  const threads = provider === 'guesty'
    ? getThreadsByReservationId(reservationId)
    : guestName ? getThreadsByListingAndGuestName(listingId, guestName) : [];
  return threads
    .flatMap((t) => getMessagesByThread(t.id))
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
}

function deDate(dateStr: string | null): string {
  if (!dateStr) return '?';
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// Liste offener Bewertungs-Entwürfe (pending + needs_review)
router.get('/', (_req, res) => {
  const drafts = getOpenReviewDrafts();
  const rows = drafts
    .map((d) => {
      const name = esc(d.guest_name) || esc(d.reservation_id);
      const { property, code } = badgeFor(d);
      const codeBadge = code
        ? `<span class="badge"${property?.uiColor ? ` style="background:${esc(property.uiColor)};color:var(--color-charcoal)"` : ''}>${esc(code)}</span>`
        : '';
      const { label, expired } = deadline(d.check_out);
      // Drei Zustände: needs_review (LLM lieferte nichts) · pending+flag_reason
      // (Problemfall, aber trotzdem gedraftet, #377-Nachbesserung 11.08.2026) ·
      // normaler pending-Entwurf. Alle drei müssen sich optisch unterscheiden.
      const statusBadge = d.status === 'needs_review'
        ? `<span class="badge" style="background:var(--color-red);color:#fff;border:none">Manuell prüfen</span>`
        : d.flag_reason
          ? `<span class="badge" style="background:var(--color-red);color:#fff;border:none">Problemfall — prüfen</span>`
          : `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">KI-Entwurf bereit</span>`;
      const expiryBadge = expired
        ? `<span class="badge" style="background:var(--color-warm-gray);color:#fff;border:none">Frist abgelaufen</span>`
        : `<span>Frist: ${esc(label)}</span>`;
      return `<li><a href="/admin/reviews/${encodeURIComponent(d.id)}">
        <span class="thread-name">${name}</span>
        <span class="thread-meta">${statusBadge}${codeBadge}${expiryBadge}<span>Checkout ${esc(d.check_out)}</span></span>
      </a></li>`;
    })
    .join('');
  const list = drafts.length
    ? `<ul class="thread-list">${rows}</ul>`
    : '<p class="empty">Keine offenen Bewertungs-Entwürfe.</p>';
  const body = `<div class="page-head">
      <h1>Gäste-Bewertungen <span class="count-pill">${drafts.length} offen</span></h1>
      <a href="/admin/messages" class="btn btn-ghost">Zu Nachrichten</a>
    </div>
    <p class="subtitle">Nach Checkout automatisch vorgeschlagene Bewertungen — Freigabe/Copy-Paste wie bei Gästenachrichten, kein Auto-Post.</p>
    <div class="section">${list}</div>`;
  res.type('html').send(renderAdminPage({ title: 'Gäste-Bewertungen', body, active: 'reviews' }));
});

// Detail
router.get('/:id', (req, res) => {
  const draft = getReviewDraftById(req.params.id);
  if (!draft) { res.status(404).send('Bewertungs-Entwurf nicht gefunden'); return; }
  const { property } = badgeFor(draft);
  const { label, expired } = deadline(draft.check_out);
  const name = esc(draft.guest_name) || esc(draft.reservation_id);

  // needs_review = LLM lieferte keinen Text (egal ob Problemfall oder nicht) — hier fehlt body,
  // Micha muss von Hand verfassen. pending+flag_reason = Problemfall MIT Entwurf (#377-Nachbesserung
  // 11.08.2026): der Entwurf existiert und ist im Text neutral gehalten (harte Prompt-Regel), aber
  // der Warnhinweis muss vor dem Posten auffallen.
  const flagBlock = draft.status === 'needs_review'
    ? `<div class="section" style="border-left:4px solid var(--color-red)">
         <h3>Bewertung: manuell entscheiden</h3>
         <p>${esc(draft.flag_reason) || 'Kein Grund hinterlegt.'}</p>
       </div>`
    : draft.flag_reason
      ? `<div class="section" style="border-left:4px solid var(--color-red)">
           <h3>Problemfall — bitte vor dem Posten prüfen</h3>
           <p>${esc(draft.flag_reason)}</p>
           <p class="subtitle">Der Entwurf unten erwähnt den Problemfall bewusst nicht (harte Prompt-Regel) — trotzdem vor Freigabe gegenlesen.</p>
         </div>`
      : '';

  const canAct = draft.status === 'pending' || draft.status === 'needs_review';
  const composeBlock = canAct
    ? `<h3>${draft.status === 'pending' ? 'Bewertungstext' : 'Manuell verfassen (optional)'}</h3>
       <form method="POST" action="/admin/reviews/${encodeURIComponent(draft.id)}/done">
         <textarea name="body" rows="6" placeholder="Bewertungstext …">${esc(draft.body)}</textarea>
         <div class="actions"><button type="submit" class="btn btn-primary">Erledigt (kopiert/gepostet)</button></div>
       </form>
       <div class="actions" style="margin-top:14px">
         ${draft.status === 'pending' ? `<form method="POST" action="/admin/reviews/${encodeURIComponent(draft.id)}/regenerate"><button type="submit" class="btn btn-ghost">Neu generieren</button></form>` : ''}
         <form method="POST" action="/admin/reviews/${encodeURIComponent(draft.id)}/discard">
           <button type="submit" class="btn btn-danger">Verwerfen</button></form>
       </div>`
    : `<p class="subtitle">Status: ${esc(draft.status)}${draft.done_at ? ` · erledigt am ${esc(draft.done_at)}` : ''}</p>
       <textarea rows="6" readonly>${esc(draft.body)}</textarea>`;

  const body = `<a class="back-link" href="/admin/reviews">&larr; Alle Bewertungs-Entwürfe</a>
    <h1>${name}</h1>
    <p class="subtitle">${property ? `<strong>${esc(property.name)}</strong> · ` : ''}Checkout ${esc(draft.check_out)} · Bewertungsfrist ${expired ? '<strong style="color:var(--color-red)">abgelaufen</strong>' : esc(label)}</p>
    ${flagBlock}
    <div class="section">${composeBlock}</div>`;
  res.type('html').send(renderAdminPage({ title: name, body, active: 'reviews' }));
});

// Erledigt (Freigabe: Micha hat den Text kopiert/gepostet — kein Auto-Send, siehe Moduldoc)
router.post('/:id/done', express.urlencoded({ extended: true }), (req, res, next) => {
  try {
    const draft = getReviewDraftById(req.params.id);
    if (!draft) { res.status(404).send('Bewertungs-Entwurf nicht gefunden'); return; }
    const edited = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    markReviewDraftDone(draft.id, edited || null);
    res.redirect(`/admin/reviews/${encodeURIComponent(draft.id)}`);
  } catch (e) { next(e); }
});

// Verwerfen
router.post('/:id/discard', (req, res, next) => {
  try {
    const draft = getReviewDraftById(req.params.id);
    if (!draft) { res.status(404).send('Bewertungs-Entwurf nicht gefunden'); return; }
    discardReviewDraft(draft.id);
    res.redirect('/admin/reviews');
  } catch (e) { next(e); }
});

// Neu generieren: reklassifiziert + generiert frisch (Freigabe-Gate bleibt, kein Auto-Post)
router.post('/:id/regenerate', async (req, res, next) => {
  try {
    const draft = getReviewDraftById(req.params.id);
    if (!draft) { res.status(404).send('Bewertungs-Entwurf nicht gefunden'); return; }
    const { property } = badgeFor(draft);
    const reservation = getReservationById(draft.reservation_id);
    const voice = loadVoice();
    if (!property || !reservation || !voice) {
      res.status(400).send('Kein Vault-Wissen oder keine Reservierung verfügbar'); return;
    }

    const messages = gatherMessages(draft.provider, draft.listing_id, draft.reservation_id, reservation.guest_name);
    const classification = messages.length === 0
      ? { classification: 'ok' as const, reasoning: 'Kein Nachrichtenverlauf für diesen Aufenthalt gefunden.' }
      : await classifyStayForReview({ messages: messages.map((m) => ({ direction: m.direction, body: m.body })) });
    const isFlagged = classification.classification === 'flagged';

    // Mirrors generate-review-drafts.ts's flagged handling (#377-Nachbesserung 11.08.2026):
    // flagged stays still get a drafted review (hard prompt rule bans mentioning the problem),
    // needs_review stays reserved for "LLM produced nothing".
    const review = await generateReviewForStay({
      guestName: reservation.guest_name,
      propertyName: property.name,
      checkInLabel: deDate(reservation.check_in_localized ?? reservation.check_in),
      checkOutLabel: deDate(reservation.check_out_localized ?? reservation.check_out),
      nights: reservation.nights_count ?? null,
      voice,
      threadHighlights: messages.filter((m) => m.direction !== 'system').map((m) => `${m.direction === 'inbound' ? 'Gast' : 'Host'}: ${m.body}`).join('\n'),
      flagged: isFlagged,
    });
    if (review) {
      setReviewDraftContent(draft.id, { status: 'pending', body: review, flag_reason: isFlagged ? classification.reasoning : null, model: REVIEW_MODEL });
    } else {
      setReviewDraftContent(draft.id, { status: 'needs_review', body: null, flag_reason: isFlagged ? classification.reasoning : 'LLM konnte keine Bewertung erzeugen.', model: null });
    }
    res.redirect(`/admin/reviews/${encodeURIComponent(draft.id)}`);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, 'review regenerate failed');
    next(e);
  }
});

export default router;
