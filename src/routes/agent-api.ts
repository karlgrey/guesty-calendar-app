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
import { runConsistencyCheck, listOpenReservations } from '../jobs/consistency-check.js';
import { getPropertyBySlug, getPropertySlugs, getListingId } from '../config/properties.js';
import type { PropertyConfig } from '../config/properties.js';
import { listDocumentsForAgent } from '../repositories/document-repository.js';
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
      guestId: r?.guest?._id ?? r?.guestId ?? null,
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

// Kalender-Konsistenz-Check + Hold-Sweep (#484) — read-only Diagnose für
// Standup/Cron. Siehe docs/superpowers/specs/2026-08-27-calendar-consistency-check.md
const VALID_RESERVATION_STATUSES = ['confirmed', 'reserved', 'inquiry'];
const DEFAULT_RESERVATION_STATUSES = ['reserved', 'inquiry'];
const DEFAULT_CONSISTENCY_WINDOW_DAYS = 28;

router.get('/consistency-check', async (req, res) => {
  try {
    let days = DEFAULT_CONSISTENCY_WINDOW_DAYS;
    if (typeof req.query.days === 'string' && req.query.days !== '') {
      const parsed = Number(req.query.days);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
        throw new ValidationError('days muss eine ganze Zahl zwischen 1 und 90 sein');
      }
      days = parsed;
    }
    const report = await runConsistencyCheck(days);
    res.json(report);
  } catch (err) { handleError(res, err); }
});

router.get('/reservations', async (req, res) => {
  try {
    let statuses = DEFAULT_RESERVATION_STATUSES;
    if (typeof req.query.status === 'string' && req.query.status !== '') {
      statuses = req.query.status.split(',').map((s) => s.trim());
      for (const s of statuses) {
        if (!VALID_RESERVATION_STATUSES.includes(s)) {
          throw new ValidationError(`Unbekannter Status: ${s} (erlaubt: ${VALID_RESERVATION_STATUSES.join('|')})`);
        }
      }
    }
    const includePast = req.query.includePast === 'true' || req.query.includePast === '1';

    // #521: property-Filter (Slug wie in data/properties.json, z. B. firenze-loft
    // fuer Florenz). Unbekannter Slug -> 400 mit Liste statt stillem Leerfilter.
    let propertySlug: string | undefined;
    if (typeof req.query.property === 'string' && req.query.property !== '') {
      propertySlug = req.query.property;
      if (!getPropertyBySlug(propertySlug)) {
        throw new ValidationError(`Unbekanntes property: ${propertySlug} (erlaubt: ${getPropertySlugs().join('|')})`);
      }
    }

    const { reservations: allReservations, errors } = await listOpenReservations(statuses, includePast);
    const reservations = propertySlug
      ? allReservations.filter((r) => r.property?.slug === propertySlug)
      : allReservations;
    res.json({ fetchedAt: new Date().toISOString(), statuses, reservations, errors });
  } catch (err) { handleError(res, err); }
});

const VALID_DOCUMENT_TYPES = ['invoice', 'quote'] as const;

// Zahlungsabgleich (#425, monatlicher Kontoabgleich statt Einzelcheck je
// Buchung) — read-only Liste aus der documents-Tabelle. HARTE REGEL: dieser
// Endpunkt ruft NIE createOrGetDocument/refreshDocument/Guesty auf und
// erzeugt NIE Dokumente oder Nummern (Vorfall 08.09.2026: die PDF-Endpunkte
// legen fehlende Dokumente an — genau das darf hier nicht passieren).
router.get('/documents', (req, res) => {
  try {
    let type: 'invoice' | 'quote' | undefined;
    if (typeof req.query.type === 'string' && req.query.type !== '') {
      if (!VALID_DOCUMENT_TYPES.includes(req.query.type as (typeof VALID_DOCUMENT_TYPES)[number])) {
        throw new ValidationError(`Unbekannter type: ${req.query.type} (erlaubt: ${VALID_DOCUMENT_TYPES.join('|')})`);
      }
      type = req.query.type as 'invoice' | 'quote';
    }

    let year: number | undefined;
    if (typeof req.query.year === 'string' && req.query.year !== '') {
      const parsed = Number(req.query.year);
      if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
        throw new ValidationError('year muss eine vierstellige Jahreszahl sein');
      }
      year = parsed;
    }

    // property-Filter wie bei GET /reservations: Slug-Validierung via
    // getPropertyBySlug. Zuordnung Dokument -> Property läuft rein lokal
    // über documents.reservation_id -> reservations.listing_id (kein
    // Guesty-API-Call) — Dokumente ohne (mehr vorhandene) lokale
    // reservations-Zeile fallen bei diesem Filter raus.
    let listingId: string | undefined;
    if (typeof req.query.property === 'string' && req.query.property !== '') {
      const property = getPropertyBySlug(req.query.property);
      if (!property) {
        throw new ValidationError(`Unbekanntes property: ${req.query.property} (erlaubt: ${getPropertySlugs().join('|')})`);
      }
      listingId = getListingId(property);
    }

    const documents = listDocumentsForAgent({ type, year, listingId });
    res.json({
      fetchedAt: new Date().toISOString(),
      count: documents.length,
      documents: documents.map((d) => ({
        id: d.id,
        documentNumber: d.documentNumber,
        documentType: d.documentType,
        reservationId: d.reservationId,
        customerName: d.customer.name,
        customerCompany: d.customer.company,
        checkIn: d.checkIn,
        checkOut: d.checkOut,
        nights: d.nights,
        guestsCount: d.guestsCount,
        total: d.total / 100,
        currency: d.currency,
        source: d.source ?? null,
        createdAt: d.createdAt,
      })),
    });
  } catch (err) { handleError(res, err); }
});

export default router;
