/**
 * Agent API — maschineller Zugang für den Angebots-Workflow (Claude).
 * Auth: Header X-Agent-Key (siehe middleware/agent-key.ts).
 * Spec: docs/superpowers/specs/2026-07-24-agent-reservierung-design.md
 */
import express from 'express';
import { requireAgentKey } from '../middleware/agent-key.js';
import {
  createOfferReservation,
  confirmOfferReservation,
  releaseOfferReservation,
} from '../services/reservation-service.js';
import { createOrGetDocument, refreshDocument } from '../services/document-service.js';
import { guestyClient } from '../services/guesty-client.js';
import { getThreadsUpdatedSince, getThreadById, getMessagesByThread } from '../repositories/message-repository.js';
import { propertyForBadge } from '../utils/thread-property.js';
import type { PropertyConfig } from '../config/properties.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(requireAgentKey);

function handleError(res: express.Response, err: unknown) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  logger.error({ err }, 'Agent API: unexpected error');
  return res.status(500).json({ error: 'Internal error' });
}

router.post('/reservations', async (req, res) => {
  try {
    const result = await createOfferReservation(req.body);
    res.status(201).json(result);
  } catch (err) { handleError(res, err); }
});

router.get('/reservations/:id', async (req, res) => {
  try {
    const r = await guestyClient.getReservation(req.params.id);
    res.json({
      id: r?._id ?? req.params.id,
      status: r?.status ?? null,
      checkIn: r?.checkInDateLocalized ?? null,
      checkOut: r?.checkOutDateLocalized ?? null,
      guestsCount: r?.guestsCount ?? null,
    });
  } catch (err) { handleError(res, err); }
});

router.get('/reservations/:id/offer.pdf', async (req, res) => {
  try {
    // ?refresh=1 zieht frische Daten aus Guesty (z. B. nachgepflegte
    // Kundenanschrift) — die Angebotsnummer bleibt dabei stabil.
    const fetchDoc = req.query.refresh ? refreshDocument : createOrGetDocument;
    const { document, pdf } = await fetchDoc({ reservationId: req.params.id, documentType: 'quote' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Document-Number', document.documentNumber);
    res.setHeader('Content-Disposition', `attachment; filename="Angebot_${document.documentNumber}.pdf"`);
    res.send(pdf);
  } catch (err) { handleError(res, err); }
});

router.get('/reservations/:id/invoice.pdf', async (req, res) => {
  try {
    // ?refresh=1 zieht frische Daten aus Guesty (z. B. nachgepflegte
    // Kundenanschrift) — die Rechnungsnummer bleibt dabei stabil.
    const fetchDoc = req.query.refresh ? refreshDocument : createOrGetDocument;
    const { document, pdf } = await fetchDoc({ reservationId: req.params.id, documentType: 'invoice' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Document-Number', document.documentNumber);
    res.setHeader('Content-Disposition', `attachment; filename="Rechnung_${document.documentNumber}.pdf"`);
    res.send(pdf);
  } catch (err) { handleError(res, err); }
});

router.put('/guests/:guestId', async (req, res) => {
  try {
    await guestyClient.updateGuest(req.params.guestId, req.body);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

router.post('/reservations/:id/confirm', async (req, res) => {
  try {
    await confirmOfferReservation(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

router.post('/reservations/:id/cancel', async (req, res) => {
  try {
    await releaseOfferReservation(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

function propertySummary(property: PropertyConfig | undefined): { slug: string; name: string; code: string } | null {
  if (!property) return null;
  return { slug: property.slug, name: property.name, code: property.shortCode ?? property.slug };
}

const DEFAULT_THREADS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_THREADS_LIMIT = 50;

// Gäste-Messaging-Threads (read-only) — damit die Claude-Hauptsession (Standup)
// Airbnb-Konversationen inkl. Bot-Antworten lesen kann, ohne DB-Zugriff.
router.get('/threads', (req, res) => {
  try {
    let sinceIso: string;
    if (typeof req.query.since === 'string' && req.query.since) {
      const parsed = new Date(req.query.since);
      if (Number.isNaN(parsed.getTime())) throw new ValidationError('since muss ein gültiger ISO-Zeitstempel sein');
      sinceIso = parsed.toISOString();
    } else {
      sinceIso = new Date(Date.now() - DEFAULT_THREADS_WINDOW_MS).toISOString();
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_THREADS_LIMIT;

    const threads = getThreadsUpdatedSince(sinceIso, limit);
    res.json({
      threads: threads.map((t) => ({
        threadId: t.id,
        source: t.source,
        property: propertySummary(propertyForBadge(t)),
        guestName: t.guest_name,
        needsReply: t.last_message_direction === 'inbound',
        lastMessageAt: t.last_message_at,
        lastMessageDirection: t.last_message_direction,
      })),
    });
  } catch (err) { handleError(res, err); }
});

router.get('/threads/:threadId', (req, res) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) throw new NotFoundError('Thread nicht gefunden');
    const msgs = getMessagesByThread(thread.id);
    const lastNonSystem = [...msgs].reverse().find((m) => m.direction !== 'system');
    res.json({
      threadId: thread.id,
      source: thread.source,
      channel: thread.channel,
      property: propertySummary(propertyForBadge(thread)),
      guestName: thread.guest_name,
      guestEmail: thread.guest_email,
      needsReply: lastNonSystem?.direction === 'inbound',
      messages: msgs.map((m) => ({
        direction: m.direction,
        sender: m.from_name,
        body: m.body,
        sentAt: m.sent_at,
      })),
    });
  } catch (err) { handleError(res, err); }
});

export default router;
