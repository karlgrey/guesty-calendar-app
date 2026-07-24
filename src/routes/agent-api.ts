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
import { AppError } from '../utils/errors.js';
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

export default router;
