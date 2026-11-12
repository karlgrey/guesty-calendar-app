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
  cancelReservation,
} from '../services/reservation-service.js';
import {
  createOrGetDocument,
  refreshDocument,
  createCancellationForInvoice,
  getCancellationWithPDF,
} from '../services/document-service.js';
import type { CanceledBy } from '../services/guesty-client.js';
import { GUESTY_CANCELLATION_REASONS, isGuestyCancellationReason } from '../services/guesty-cancellation.js';
import { guestyClient } from '../services/guesty-client.js';
import { updateReservation, toReservationView } from '../services/reservation-update-service.js';
import { setStayTimes, deleteStayTimes, getStayTimes, type StayTimesResult } from '../services/stay-times-service.js';
import { updateGuestCompanyByGuestId } from '../repositories/reservation-repository.js';
import { getThreadsUpdatedSince, getThreadById, getMessagesByThread } from '../repositories/message-repository.js';
import { getAwaitingDrafts, getAutoSendStats, listAutoDecisionCases } from '../repositories/draft-repository.js';
import { autoDecisionOutcome, autoDecisionTexts } from '../services/auto-send/decision-case.js';
import { propertyForBadge } from '../utils/thread-property.js';
import { runConsistencyCheck, listOpenReservations } from '../jobs/consistency-check.js';
import { getPropertyBySlug, getPropertySlugs, getListingId, getAllProperties } from '../config/properties.js';
import type { PropertyConfig } from '../config/properties.js';
import { listDocumentsForAgent, getDocumentById } from '../repositories/document-repository.js';
import { AppError, ConflictError, ExternalApiError, NotFoundError, ValidationError } from '../utils/errors.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { syncAvailability } from '../jobs/sync-availability.js';
import { syncHostexProperty } from '../jobs/hostex/sync-properties.js';
import { syncHostexReservations } from '../jobs/hostex/sync-reservations.js';
import { syncHostexCalendar } from '../jobs/hostex/sync-calendar.js';
import { getHostexClient } from '../services/hostex-client.js';
import { groupBlockedRanges } from '../services/availability-blocks.js';
import { getSuggestionsByStatus } from '../repositories/feedback-repository.js';
import { revokeVaultSuggestion } from '../services/vault-suggestion-service.js';
import type { SuggestionStatus } from '../types/feedback.js';
import { berlinCalendarDay } from '../services/auto-send/berlin-day.js';
import { getListingTextsForProperty } from '../services/listing-texts-service.js';
import { syncListing } from '../jobs/sync-listing.js';

const router = express.Router();
router.use(requireAgentKey);

function handleError(res: express.Response, err: unknown) {
  if (err instanceof AppError) {
    // Externe API-Fehler (Guesty & Co.): Details (Fehlertext des Anbieters)
    // an den Agent durchreichen und loggen, sonst ist der Grund eines 4xx weg.
    if (err instanceof ExternalApiError && err.details !== undefined) {
      logger.warn({ err, details: err.details }, 'Agent API: external API error');
      return res.status(err.statusCode).json({ error: err.message, details: err.details });
    }
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
    // #799: effektive Zeiten aus unserer DB dazu (Lookup non-fatal; keine lokale Zeile -> null)
    let times = null;
    try { times = getStayTimes(req.params.id)?.times ?? null; } catch (error) {
      logger.warn({ error, reservationId: req.params.id }, 'Agent API: times-Lookup fehlgeschlagen (non-fatal)');
    }
    res.json({ ...toReservationView(r, req.params.id), times });
  } catch (err) { handleError(res, err); }
});

// Zeit-Abweichungen plattformneutral (#799, Guesty + Hostex, Migration 035/036): Zusagen (Late-
// Checkout, früher Check-in, Folgetag-Block) leben in unserer DB; der Kalender-Marker für die
// Putzcrew entsteht beim Kalender-Sync. Guesty wird nur für den Folgetag-Block geschrieben
// (nur Objekte mit blocksNextDayOnLateCheckout, Listing-Kalender, nur wenn der Tag frei ist). Logik: services/stay-times-service.ts.
function sendTimesResult(res: express.Response, result: StayTimesResult) {
  if (result.blockError) {
    // Override ist gespeichert (Marker wichtiger als Block) — aber Guesty hat den Block abgelehnt.
    const { blockError, ok: _ok, ...rest } = result;
    return res.status(409).json({ error: `Folgetag-Block bei Guesty fehlgeschlagen: ${blockError.message}`, details: blockError.details, ...rest });
  }
  return res.json(result);
}

router.get('/reservations/:id/times', (req, res) => {
  try {
    const view = getStayTimes(req.params.id);
    if (!view) throw new NotFoundError(`Reservierung ${req.params.id} ist lokal nicht bekannt`);
    res.json(view);
  } catch (err) { handleError(res, err); }
});

router.put('/reservations/:id/times', async (req, res) => {
  try {
    sendTimesResult(res, await setStayTimes(req.params.id, req.body, 'agent'));
  } catch (err) { handleError(res, err); }
});

router.delete('/reservations/:id/times', async (req, res) => {
  try {
    sendTimesResult(res, await deleteStayTimes(req.params.id));
  } catch (err) { handleError(res, err); }
});

// Reservierung ändern (#792): Daten, Gästezahl, geplante Zeiten, Early-Check-in/
// Late-Checkout. Nur Direktbuchungen im Status reserved/confirmed — Logik und
// Guards im Service.
router.patch('/reservations/:id', async (req, res) => {
  try {
    res.json(await updateReservation(req.params.id, req.body));
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

// Kundenstamm lesen (#715): Ist-Stand vor einem PUT sichtbar machen, damit die
// Session nichts blind überschreibt. Bewusst reduzierter Shape — Guesty-interne
// Felder (notes, tags, hometown …) bleiben draußen.
router.get('/guests/:guestId', async (req, res) => {
  try {
    const g = await guestyClient.getGuest(req.params.guestId);
    const address = g.address
      ? {
          street: g.address.street ?? null,
          city: g.address.city ?? null,
          zipcode: g.address.zipcode ?? (g.address as any).zipCode ?? null,
          country: g.address.country ?? null,
          full: g.address.full ?? null,
        }
      : null;
    res.json({
      id: g._id ?? req.params.guestId,
      firstName: g.firstName ?? null,
      lastName: g.lastName ?? null,
      fullName: g.fullName ?? null,
      email: g.email ?? null,
      phone: g.phone ?? g.phones?.[0] ?? null,
      company: g.company ?? null,
      address,
    });
  } catch (err) { handleError(res, err); }
});

// Whitelist der schreibbaren Felder — der Body ging bisher ungefiltert an
// Guesty (#715): Tippfehler wie `phones` statt `phone` sollen als 400 auffallen,
// nicht still in Guesty landen.
const GUEST_WRITABLE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'company', 'address'] as const;

router.put('/guests/:guestId', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body muss ein JSON-Objekt sein');
    }
    const unknown = Object.keys(body).filter((k) => !(GUEST_WRITABLE_FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw new ValidationError(`Unbekannte Felder: ${unknown.join(', ')} — erlaubt: ${GUEST_WRITABLE_FIELDS.join(', ')}`);
    }
    if (Object.keys(body).length === 0) {
      throw new ValidationError(`Body ist leer — erlaubt: ${GUEST_WRITABLE_FIELDS.join(', ')}`);
    }
    await guestyClient.updateGuest(req.params.guestId, body);

    // #729 (Fall momox): eine mitgeschickte company spiegelt sich sofort in
    // ALLE bestehenden Reservierungen dieses guest_id (Dashboard zeigt die
    // Firma dann ohne Wartezeit auf den nächsten Backfill/ETL). Best-effort:
    // der Guesty-Schreibvorgang ist bereits durch — ein DB-Problem hier soll
    // die Antwort nicht zum Fehler machen.
    if (Object.prototype.hasOwnProperty.call(body, 'company')) {
      try {
        updateGuestCompanyByGuestId(req.params.guestId, typeof body.company === 'string' ? body.company : null);
      } catch (dbError) {
        logger.warn(
          { dbError, guestId: req.params.guestId },
          'guest_company-Spiegelung in reservations fehlgeschlagen (Guesty-Update war erfolgreich)'
        );
      }
    }

    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

router.post('/reservations/:id/confirm', async (req, res) => {
  try {
    await confirmOfferReservation(req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

const CANCELED_BY_VALUES: readonly CanceledBy[] = ['OWNER', 'GUEST', 'TEAM_MEMBER', 'HOST'];

// Storno/Freigabe (#771): Hold/Anfrage -> 'closed', bestätigt -> 'canceled'
// mit Grund (Body optional {"reason": "..."} aus GUESTY_CANCELLATION_REASONS,
// Default 'Guest Convenience'), schon storniert -> No-op.
router.post('/reservations/:id/cancel', async (req, res) => {
  try {
    const reason = req.body?.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
      throw new ValidationError('reason muss ein nicht-leerer String sein');
    }
    // Guesty nimmt nur Gründe aus fester Liste (#776) — vorab prüfen statt 400-Roundtrip.
    if (reason !== undefined && !isGuestyCancellationReason(reason.trim())) {
      throw new ValidationError(`reason muss einer von: ${GUESTY_CANCELLATION_REASONS.join(' · ')}`);
    }
    const canceledBy = req.body?.canceledBy;
    if (canceledBy !== undefined && !CANCELED_BY_VALUES.includes(canceledBy as CanceledBy)) {
      throw new ValidationError(`canceledBy muss einer von ${CANCELED_BY_VALUES.join('/')} sein`);
    }
    const result = await cancelReservation(req.params.id, reason?.trim(), canceledBy);
    res.json({ ok: true, ...result });
  } catch (err) { handleError(res, err); }
});

// Storno-Beleg zur Rechnung der Reservierung (#771): negativer Beleg mit
// eigener Nummer aus dem Rechnungs-Nummernkreis, Originalrechnung bleibt
// unverändert. Idempotent (201 neu, 200 bereits vorhanden).
router.post('/reservations/:id/invoice-cancel', async (req, res) => {
  try {
    const { document, invoice, isNew } = await createCancellationForInvoice(req.params.id);
    res.status(isNew ? 201 : 200).json({
      ok: true,
      isNew,
      documentId: document.id,
      documentNumber: document.documentNumber,
      documentType: document.documentType,
      cancelsDocumentId: invoice.id,
      cancelsDocumentNumber: invoice.documentNumber,
      total: document.total / 100,
      currency: document.currency,
      createdAt: document.createdAt,
      pdfPath: `/api/agent/reservations/${req.params.id}/cancellation.pdf`,
    });
  } catch (err) { handleError(res, err); }
});

// Storno-Beleg als PDF — legt NIE an (404, solange keiner existiert).
router.get('/reservations/:id/cancellation.pdf', async (req, res) => {
  try {
    const result = await getCancellationWithPDF(req.params.id);
    if (!result) throw new NotFoundError('Kein Storno-Beleg zu dieser Reservierung');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Document-Number', result.document.documentNumber);
    res.setHeader('Content-Disposition', `attachment; filename="Stornorechnung_${result.document.documentNumber}.pdf"`);
    res.send(result.pdf);
  } catch (err) { handleError(res, err); }
});

function propertySummary(
  property: PropertyConfig | undefined,
): { slug: string; name: string; code: string; shortCode: string | null } | null {
  if (!property) return null;
  // shortCode zusätzlich zu code (additiv, #Task-12-Fix-Runde-1): der
  // labs-Watcher (Task 14) liest property.shortCode und fällt sonst auf den
  // Slug zurück ("farmhouse" statt "FH" im Push) — code bleibt unverändert,
  // damit bestehende /threads-Konsumenten stabil bleiben.
  return {
    slug: property.slug, name: property.name,
    code: property.shortCode ?? property.slug,
    shortCode: property.shortCode ?? null,
  };
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
        autoDecision: t.auto_decision ?? null,
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

const VALID_DOCUMENT_TYPES = ['invoice', 'quote', 'cancellation'] as const;

// Zahlungsabgleich (#425, monatlicher Kontoabgleich statt Einzelcheck je
// Buchung) — read-only Liste aus der documents-Tabelle. HARTE REGEL: dieser
// Endpunkt ruft NIE createOrGetDocument/refreshDocument/Guesty auf und
// erzeugt NIE Dokumente oder Nummern (Vorfall 08.09.2026: die PDF-Endpunkte
// legen fehlende Dokumente an — genau das darf hier nicht passieren).
router.get('/documents', (req, res) => {
  try {
    let type: (typeof VALID_DOCUMENT_TYPES)[number] | undefined;
    if (typeof req.query.type === 'string' && req.query.type !== '') {
      if (!VALID_DOCUMENT_TYPES.includes(req.query.type as (typeof VALID_DOCUMENT_TYPES)[number])) {
        throw new ValidationError(`Unbekannter type: ${req.query.type} (erlaubt: ${VALID_DOCUMENT_TYPES.join('|')})`);
      }
      type = req.query.type as (typeof VALID_DOCUMENT_TYPES)[number];
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
        cancelsDocumentId: d.cancelsDocumentId ?? null,
        cancelsDocumentNumber: d.cancelsDocumentId ? (getDocumentById(d.cancelsDocumentId)?.documentNumber ?? null) : null,
        createdAt: d.createdAt,
      })),
    });
  } catch (err) { handleError(res, err); }
});

// Erste Zeile der Gästenachricht (bis zum ersten Zeilenumbruch), Leerraum
// vereinheitlicht, max. 160 Zeichen — für den Push-Text (adminUrl-Vorschau,
// labs-Watcher). Bewusst keine Satz-Erkennung: eine Frage mit "?" mitten in
// der ersten Zeile soll nicht vorzeitig abgeschnitten werden.
export function guestExcerpt(text: string | null): string {
  const firstLine = (text ?? '').split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

// SQLite speichert Timestamps als "YYYY-MM-DD HH:MM:SS" (UTC, ohne Zone) —
// der labs-Watcher vergleicht Strings lexikographisch, deshalb hier immer
// auf ISO-UTC normalisieren.
const sqliteToIso = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();

// Wartende Entwürfe (Auto-Send-Gate: 'wait'-Entscheidung oder Send-Fehler) —
// für den labs-Watcher/Push an Micha. Siehe Abschnitt 7.2 im Design-Doc.
router.get('/drafts/awaiting', (req, res) => {
  try {
    let sinceIso = new Date(Date.now() - DEFAULT_THREADS_WINDOW_MS).toISOString();
    if (typeof req.query.since === 'string' && req.query.since) {
      const parsed = new Date(req.query.since);
      if (Number.isNaN(parsed.getTime())) throw new ValidationError('since muss ein gültiger ISO-Zeitstempel sein');
      sinceIso = parsed.toISOString();
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const rows = getAwaitingDrafts(sinceIso, limit);
    res.json({
      drafts: rows.map((r) => ({
        draftId: r.id, threadId: r.thread_id,
        property: propertySummary(propertyForBadge({ source: r.source, listing_id: r.listing_id })),
        guestName: r.guest_name, guestMessageExcerpt: guestExcerpt(r.last_guest_message),
        reason: r.reason, createdAt: sqliteToIso(r.created_at),
        adminUrl: `${config.baseUrl.replace(/\/$/, '')}/admin/messages/${encodeURIComponent(r.thread_id)}`,
        // #696: Zusagen-Task, wenn dieser Entwurf einen SmartTasks-Task trackt (z. B. ein
        // hängender Auto-Send, dessen Zusage bereits nachgehalten wird) — dieselbe Spalte trägt
        // seit #697 auch den Buchungsanfrage-Task.
        smartTasksTaskId: r.smarttasks_task_id ?? null,
        // #697: Buchungsanfrage-Felder — platformDeadlineAt ist bereits ein ISO-8601-UTC-String
        // (siehe booking-request.ts), keine sqliteToIso-Normalisierung nötig (anders als
        // createdAt, das aus SQLite datetime('now') kommt).
        platformDeadlineAt: r.platform_deadline_at ?? null,
        requestKind: r.request_kind ?? null,
        category: r.auto_category ?? null,
        autoDecision: r.auto_decision ?? null,
        autoMode: r.auto_mode ?? null,
        // #702 Punkt 4: reasoning-Feld des Prüfmodells, zusätzlich zum Policy-Text in `reason`.
        judgeReasoning: r.auto_judge_reasoning ?? null,
      })),
    });
  } catch (err) { handleError(res, err); }
});

// Auto-Send-Statistik (Kennzahlen fürs Standup/Review) — Shadow-Mode-Quote
// zeigt, wie oft der Bot-Entwurf im Shadow-Betrieb unverändert versendet wurde.
router.get('/auto-send/stats', (req, res) => {
  try {
    const daysRaw = typeof req.query.days === 'string' ? Number(req.query.days) : 1;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 1;
    const s = getAutoSendStats(new Date(Date.now() - days * 86400000).toISOString());
    const n = (v: number | null) => v ?? 0;
    const denom = n(s.shadowUnchanged) + n(s.shadowChanged);
    res.json({
      autoSent: n(s.autoSent),
      waited: n(s.waited),
      shadowWouldAuto: n(s.shadowWouldAuto),
      shadowUnchanged: n(s.shadowUnchanged),
      shadowChanged: n(s.shadowChanged),
      shadowDiscarded: n(s.shadowDiscarded),
      shadowUnchangedRate: denom ? Math.round((100 * n(s.shadowUnchanged)) / denom) : null,
    });
  } catch (err) { handleError(res, err); }
});

// #1044: Einzelfälle des Auto-Send-Gates (Schattenphase auswerten) — pro Entscheidung Outcome,
// Texte und Feedback. Bei 'changed' liefert original_body (#1062, Migration 039) den Entwurfstext
// vor Michas Edit: draftText = original_body, sentText = body, diff = kompakter Zeilen-Diff.
// Ohne original_body (vor Migration 039 gesendet) draftText=null, draftTextLost=true
// (previous_body ist hier unbrauchbar — Vorversion einer automatischen Neugenerierung).
router.get('/auto-send/decisions', (req, res) => {
  try {
    // Ungültige Zahlen → 400 (nicht still auf Default); days gekappt, sonst wirft
    // Date#toISOString bei absurden Werten RangeError → 500.
    const daysRaw = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
    if (!Number.isFinite(daysRaw) || daysRaw <= 0) throw new ValidationError(`Ungültiger days-Wert: ${req.query.days}`);
    const days = Math.min(daysRaw, 3650);
    const decision = typeof req.query.decision === 'string' ? req.query.decision : 'all';
    if (decision !== 'auto' && decision !== 'wait' && decision !== 'all') {
      throw new ValidationError(`Unbekannte decision: ${decision} (erlaubt: auto|wait|all)`);
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
    if (!Number.isFinite(limitRaw) || limitRaw <= 0) throw new ValidationError(`Ungültiger limit-Wert: ${req.query.limit}`);
    const limit = Math.min(Math.floor(limitRaw), 500);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const parseArray = (json: string | null): unknown[] => {
      try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
    };
    const rows = listAutoDecisionCases(since, decision === 'all' ? null : decision, limit);
    res.json({
      days, decision, count: rows.length,
      decisions: rows.map((r) => {
        const outcome = autoDecisionOutcome(r);
        return {
          draftId: r.id, threadId: r.thread_id, provider: r.provider,
          property: propertySummary(propertyForBadge({ source: r.source, listing_id: r.listing_id })),
          guestName: r.guest_name, category: r.auto_category, decision: r.auto_decision, mode: r.auto_mode,
          reason: r.auto_reason, judgeReasoning: r.auto_judge_reasoning ?? null,
          flags: parseArray(r.auto_flags),
          outcome,
          feedback: (parseArray(r.feedback_json) as Array<{ category: string; note: string; createdAt: string }>)
            .map((f) => ({ ...f, createdAt: sqliteToIso(f.createdAt) })),
          createdAt: sqliteToIso(r.created_at),
          judgedAt: r.auto_judged_at ? sqliteToIso(r.auto_judged_at) : null,
          sentAt: r.sent_at ? sqliteToIso(r.sent_at) : null,
          ...autoDecisionTexts(outcome, r.body, r.original_body),
        };
      }),
    });
  } catch (err) { handleError(res, err); }
});

// Hostex Owner-Blocks (#725) — Kalender sperren/freigeben für Hostex-Objekte
// (Bootshaus, Alte Schilderwerkstatt). Guesty-Blocks sind NICHT Teil dieses
// Auftrags; die Provider-Weiche unten liefert bei provider=guesty/airbnb-mail
// bewusst 400, damit ein Guesty-Zweig später ergänzt werden kann, ohne den
// Endpunkt neu zu schneiden.
const HOSTEX_MAX_RANGE_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function requireValidDate(label: string, value: string): void {
  if (!DATE_RE.test(value) || !isValidCalendarDate(value)) {
    throw new ValidationError(`${label} muss ein gültiges Datum im Format YYYY-MM-DD sein: ${value}`);
  }
}

function daysBetween(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Slug → hostex-Property auflösen, 404 bei unbekanntem Slug, 400 bei Nicht-Hostex-Provider. */
function getHostexProperty(slug: string): PropertyConfig {
  const property = getPropertyBySlug(slug);
  if (!property) throw new NotFoundError(`Unbekanntes property: ${slug} (erlaubt: ${getPropertySlugs().join('|')})`);
  if (property.provider !== 'hostex') {
    throw new ValidationError(`property ${slug} hat Provider "${property.provider}" — dieser Endpunkt gilt nur für provider=hostex`);
  }
  return property;
}

/** from/to validieren: Format, echte Kalendertage, from<=to, max. Spanne, to nicht in der Vergangenheit. */
function validateAvailabilityRange(fromRaw: string, toRaw: string): { from: string; to: string } {
  requireValidDate('from', fromRaw);
  requireValidDate('to', toRaw);
  if (fromRaw > toRaw) {
    throw new ValidationError(`from (${fromRaw}) darf nicht nach to (${toRaw}) liegen`);
  }
  const rangeDays = daysBetween(fromRaw, toRaw) + 1;
  if (rangeDays > HOSTEX_MAX_RANGE_DAYS) {
    throw new ValidationError(`Zeitraum zu groß: max. ${HOSTEX_MAX_RANGE_DAYS} Tage (angefragt: ${rangeDays})`);
  }
  const todayBerlin = berlinCalendarDay(new Date().toISOString());
  if (toRaw < todayBerlin) {
    throw new ValidationError(`to (${toRaw}) darf nicht in der Vergangenheit liegen (heute: ${todayBerlin})`);
  }
  return { from: fromRaw, to: toRaw };
}

function hostexPropertySummary(property: PropertyConfig, hostexPropertyId: string) {
  return { slug: property.slug, name: property.name, provider: property.provider, hostexPropertyId };
}

// ---------------------------------------------------------------------------
// #1043 Öffentliche Listing-Texte (für #983 Telefonnummern-Check + Lint-Drift-Check)
// Nur lesend. :id = property-Slug oder Guesty-/Hostex-Listing-ID.
// ---------------------------------------------------------------------------
router.get('/listings/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const property = getPropertyBySlug(id)
      ?? getAllProperties().find((p) => p.guestyPropertyId === id || p.hostexPropertyId === id);
    if (!property) throw new NotFoundError(`Unbekanntes Listing: ${id} (Slug: ${getPropertySlugs().join('|')})`);
    const result = await getListingTextsForProperty(property);
    res.json({
      property: { slug: property.slug, name: property.name, provider: property.provider, listingId: getListingId(property) },
      available: result.available,
      publicDescription: result.texts?.publicDescription ?? null,
      guestInstructions: result.texts?.guestInstructions ?? null,
      ...(result.note ? { note: result.note } : {}),
    });
  } catch (err) { handleError(res, err); }
});

// #1137 Reinigungsgebühr eines Guesty-Inserats setzen (Betrag netto in Euro).
// previous/current kommen aus Guesty (GET prices.cleaningFee vor bzw. nach dem Update),
// nicht aus dem Request. Danach lokaler Listing-Cache sofort aufgefrischt.
const CLEANING_FEE_MAX = 1000;

function parseCleaningFeeAmount(body: unknown): number {
  const amount = (body as { amount?: unknown } | null | undefined)?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ValidationError('Body muss {"amount": <Zahl in Euro, netto>} enthalten');
  }
  if (amount <= 0 || amount > CLEANING_FEE_MAX) {
    throw new ValidationError(`amount muss > 0 und ≤ ${CLEANING_FEE_MAX} sein (angefragt: ${amount})`);
  }
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
    throw new ValidationError('amount darf höchstens zwei Nachkommastellen haben');
  }
  return amount;
}

// Geschwister-Schlüssel unter cleaningFee (Kanal-Overrides), ohne value und Zeitstempel.
function cleaningFeeChannelOverrides(financials: any): Record<string, unknown> {
  const cf = financials?.cleaningFee;
  if (!cf || typeof cf !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cf)) {
    if (k === 'value' || k === 'lastUpdatedAt' || k === 'lastUpdated') continue;
    out[k] = v;
  }
  return out;
}

// Stabiler Vergleichs-String. `channelSyncStatus` bleibt außen vor: der Status wechselt
// nach einem Update legitim (IN_PROGRESS → SYNCED) und ist kein Wertverlust — in der
// Antwort (channelOverrides.before/after) steht er weiterhin.
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => k !== 'channelSyncStatus').sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

router.put('/listings/:slug/cleaning-fee', async (req, res) => {
  try {
    const property = getPropertyBySlug(req.params.slug);
    if (!property) throw new NotFoundError(`Unbekanntes Objekt: ${req.params.slug} (Slug: ${getPropertySlugs().join('|')})`);
    const amount = parseCleaningFeeAmount(req.body);
    if (property.provider !== 'guesty') {
      throw new ValidationError(`Reinigungsgebühr nur für provider=guesty (Objekt ${property.slug}: ${property.provider})`);
    }
    const listingId = getListingId(property);

    // Ist-Stand VOR dem Update: Financials (Wertlogik + Kanal-Overrides) und Listing (previous).
    const financialsBefore = await guestyClient.getListingFinancials(listingId);
    const existing = financialsBefore?.cleaningFee?.value;
    if (existing?.valueType === 'PERCENTAGE') {
      throw new ConflictError('Reinigungsgebühr ist prozentual (PERCENTAGE) — Betrag in Euro nicht setzbar, bitte in Guesty ändern');
    }
    const valueType = existing?.valueType ?? 'FIXED';
    const multiplier = existing?.multiplier ?? 'PER_STAY';
    const overridesBefore = cleaningFeeChannelOverrides(financialsBefore);

    const before = await guestyClient.getListing(listingId);
    const previous = before.prices?.cleaningFee ?? null;

    await guestyClient.updateListingCleaningFee(listingId, amount, { valueType, multiplier });

    // Ab hier ist der Schreibvorgang durch: Fehler beim Nachlesen sind KEIN gescheitertes Update.
    let current: number | null = null;
    let overridesAfter: Record<string, unknown> | null = null;
    let verifyError: string | undefined;
    try {
      const after = await guestyClient.getListing(listingId);
      current = after.prices?.cleaningFee ?? null;
      overridesAfter = cleaningFeeChannelOverrides(await guestyClient.getListingFinancials(listingId));
    } catch (verifyErr) {
      verifyError = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      logger.warn({ slug: property.slug, listingId, err: verifyErr }, 'Cleaning fee written, but re-reading Guesty failed');
    }

    const overridesChanged = overridesAfter !== null
      && stableStringify(overridesBefore) !== stableStringify(overridesAfter);
    if (overridesChanged) {
      logger.warn(
        { slug: property.slug, listingId, overridesBefore, overridesAfter },
        'Cleaning fee update changed channel overrides (alte Werte zur Wiederherstellung)',
      );
    }

    // Cache auffrischen (bestehender Sync-Pfad: getListing → mapListing → upsertListing).
    // Der Guesty-Schreibvorgang ist durch — ein Cache-Problem macht die Antwort nicht zum Fehler.
    const sync = await syncListing(listingId, true);

    logger.info({ slug: property.slug, previous, current }, 'Listing cleaning fee updated');

    res.json({
      slug: property.slug, listingId, previous, current,
      channelOverrides: { before: overridesBefore, after: overridesAfter },
      ...(overridesChanged ? { overridesChanged: true } : {}),
      ...(verifyError !== undefined
        ? { written: true, verifyFailed: true, verifyError, note: 'Schreibvorgang erfolgt, current/channelOverrides.after unbekannt — GET prüfen' }
        : {}),
      ...(sync.success ? {} : { cacheRefreshed: false }),
    });
  } catch (err) { handleError(res, err); }
});

router.get('/availability/:slug', async (req, res) => {
  try {
    const property = getHostexProperty(req.params.slug);
    const todayBerlin = berlinCalendarDay(new Date().toISOString());
    const fromRaw = typeof req.query.from === 'string' && req.query.from !== '' ? req.query.from : todayBerlin;
    requireValidDate('from', fromRaw);
    const toRaw = typeof req.query.to === 'string' && req.query.to !== '' ? req.query.to : addDaysToDateString(fromRaw, 365);
    const { from, to } = validateAvailabilityRange(fromRaw, toRaw);

    const hostexPropertyId = getListingId(property);
    const [propertyAvailability] = await getHostexClient().getAvailabilities([hostexPropertyId], from, to);
    const days = (propertyAvailability?.availabilities ?? []).map((d) => ({
      date: d.date, available: d.available, remarks: d.remarks ?? '',
    }));

    res.json({
      property: hostexPropertySummary(property, hostexPropertyId),
      from, to, days,
      blockedRanges: groupBlockedRanges(days),
    });
  } catch (err) { handleError(res, err); }
});

async function handleAvailabilityMutation(req: express.Request, res: express.Response, available: boolean) {
  try {
    const property = getHostexProperty(req.params.slug);
    const body = req.body;
    if (!body || typeof body.from !== 'string' || typeof body.to !== 'string') {
      throw new ValidationError('Body muss from und to (YYYY-MM-DD) enthalten');
    }
    const { from, to } = validateAvailabilityRange(body.from, body.to);
    const hostexPropertyId = getListingId(property);

    await getHostexClient().updateAvailabilities({ propertyIds: [hostexPropertyId], startDate: from, endDate: to, available });
    logger.info({ slug: property.slug, from, to, available }, 'Hostex availability mutation');

    res.json({
      property: hostexPropertySummary(property, hostexPropertyId),
      from, to, available, nights: daysBetween(from, to) + 1,
      async: true,
      note: 'Hostex verarbeitet asynchron — Stand mit GET /availability prüfen',
    });
  } catch (err) { handleError(res, err); }
}

router.post('/availability/:slug/block', (req, res) => handleAvailabilityMutation(req, res, false));
router.post('/availability/:slug/unblock', (req, res) => handleAvailabilityMutation(req, res, true));

// #1055 Verfügbarkeits-Sync als Agent-Route (Fall Enpal #1039: cancel + neu anlegen ohne Warten auf den Stunden-ETL)
router.post('/availability/:slug/sync', async (req, res) => {
  try {
    const slug = req.params.slug;
    const property = getPropertyBySlug(slug);
    if (!property) {
      throw new NotFoundError(`Unbekanntes property: ${slug} (erlaubt: ${getPropertySlugs().join('|')})`);
    }
    const force = req.query.force === 'true';
    const listingId = getListingId(property);

    let success: boolean;
    let skipped = false;
    let result: unknown;

    if (property.provider === 'guesty') {
      const r = await syncAvailability(listingId, force);
      success = r.success;
      skipped = r.skipped ?? false;
      result = r;
    } else if (property.provider === 'hostex') {
      // Wie runHostexETL, aber ohne Nachrichten/Drafts. force wird ignoriert:
      // die Hostex-Schritte haben keinen Cache-Skip.
      const p = await syncHostexProperty(property);
      if (!p.success || !p.hostexProperty) {
        success = false;
        result = { listingId, property: p, reservations: null, calendar: null };
      } else {
        // Reservierungen zuerst: der Kalender-Sync liest die lokalen Reservierungen
        // für die Overlap-Erkennung — sonst blockiert eine gerade stornierte Buchung weiter.
        const resv = await syncHostexReservations(property);
        const cal = await syncHostexCalendar(property, p.hostexProperty);
        success = resv.success && cal.success;
        result = { listingId, reservations: resv, calendar: cal, daysCount: cal.daysCount };
      }
    } else {
      throw new ValidationError(
        `property ${slug} hat Provider "${property.provider}" — Sync-Route gilt nur für guesty|hostex`,
      );
    }

    logger.info({ slug, provider: property.provider, force, success }, 'Agent availability sync');

    res.status(success ? 200 : 502).json({
      success,
      message: success
        ? (skipped ? 'Availability cache is fresh, no sync needed' : 'Availability synced successfully')
        : 'Availability sync failed',
      property: { slug: property.slug, name: property.name, provider: property.provider, listingId },
      force,
      result,
    });
  } catch (err) { handleError(res, err); }
});

// ---------------------------------------------------------------------------
// #969 Vault-Vorschläge: Liste + Rücknahme freigegebener Vorschläge
// ---------------------------------------------------------------------------
const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ['pending', 'approved', 'revoked', 'discarded'];

router.get('/vault-suggestions', (req, res) => {
  try {
    const raw = req.query.status;
    const status = raw === undefined ? 'pending' : raw;
    if (typeof status !== 'string' || !(SUGGESTION_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`status muss einer von ${SUGGESTION_STATUSES.join('|')} sein`);
    }
    const suggestions = getSuggestionsByStatus(status as SuggestionStatus).map((s) => ({
      id: s.id,
      feedback_id: s.feedback_id,
      target_file: s.target_file,
      target_heading: s.target_heading,
      addition_text: s.addition_text,
      rationale: s.rationale,
      status: s.status,
      applied_commit: s.applied_commit,
      applied_at: s.applied_at,
      revoked_at: s.revoked_at ?? null,
      revoke_commit: s.revoke_commit ?? null,
      created_at: s.created_at ?? null,
    }));
    res.json({ suggestions });
  } catch (err) { handleError(res, err); }
});

router.post('/vault-suggestions/:id/revoke', (req, res) => {
  try {
    const result = revokeVaultSuggestion(req.params.id);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({
      id: result.suggestion.id,
      status: result.suggestion.status,
      revoke_commit: result.suggestion.revoke_commit ?? null,
      removed: result.removed ?? false,
      pushed: result.pushed,
      alreadyRevoked: result.alreadyRevoked ?? false,
    });
  } catch (err) { handleError(res, err); }
});

export default router;
