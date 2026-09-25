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
import { updateGuestCompanyByGuestId } from '../repositories/reservation-repository.js';
import { getThreadsUpdatedSince, getThreadById, getMessagesByThread } from '../repositories/message-repository.js';
import { getAwaitingDrafts, getAutoSendStats } from '../repositories/draft-repository.js';
import { propertyForBadge } from '../utils/thread-property.js';
import { runConsistencyCheck, listOpenReservations } from '../jobs/consistency-check.js';
import { getPropertyBySlug, getPropertySlugs, getListingId } from '../config/properties.js';
import type { PropertyConfig } from '../config/properties.js';
import { listDocumentsForAgent } from '../repositories/document-repository.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { getHostexClient } from '../services/hostex-client.js';
import { groupBlockedRanges } from '../services/availability-blocks.js';
import { berlinCalendarDay } from '../services/auto-send/berlin-day.js';

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

router.post('/reservations/:id/cancel', async (req, res) => {
  try {
    await releaseOfferReservation(req.params.id);
    res.json({ ok: true });
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

export default router;
