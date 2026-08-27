/**
 * Kalender-Konsistenz-Check + Hold-Sweep (#484)
 *
 * Orchestriert den Live-Abgleich zwischen den Provider-Quellen (bewusst am
 * DB-Cache vorbei) und dem tatsächlichen Google-Kalenderinhalt, sowie den
 * Sweep über offene/unbestätigte Reservierungen (vergessene Holds).
 * Read-only: keine Schreib-Calls auf Google/Guesty/Hostex.
 *
 * Die Erwartungsberechnung MUSS exakt der Schreiblogik von
 * `sync-google-calendar.ts` entsprechen (Event-IDs via
 * toGoogleEventId/blockEventId, Datumslogik addOneDay, *_localized-Fallback)
 * — sonst entstehen False Positives.
 *
 * See docs/superpowers/specs/2026-08-27-calendar-consistency-check.md
 */
import { toZonedTime } from 'date-fns-tz';
import { guestyClient } from '../services/guesty-client.js';
import { getHostexClient } from '../services/hostex-client.js';
import { fetchAirbnbIcal } from '../services/airbnb-mail/ical-fetcher.js';
import { parseAirbnbIcal } from '../parsers/airbnb-mail/ical-parser.js';
import { buildAvailabilityRows } from '../mappers/airbnb-mail/availability-mapper.js';
import { mapAvailabilityBatch } from '../mappers/availability-mapper.js';
import { mapHostexReservation } from '../mappers/hostex/reservation-mapper.js';
import { mapHostexCalendarDay } from '../mappers/hostex/calendar-mapper.js';
import { groupBookedIntervals } from './airbnb-mail/reconcile-ical.js';
import { buildBlockSpans, blockEventId } from '../services/google-calendar-blocks.js';
import { toGoogleEventId } from '../services/google-event-id.js';
import { googleCalendarClient } from '../services/google-calendar-client.js';
import { addOneDay } from '../utils/date.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getAvailabilityLastSyncedAt } from '../repositories/availability-repository.js';
import {
  getAllProperties,
  getListingId,
  getPropertyByGuestyId,
  getPropertiesByProvider,
  type PropertyConfig,
} from '../config/properties.js';
import {
  diffCalendarEvents,
  overlapsWindow,
  type ExpectedEvent,
  type GoogleEventLite,
  type ConsistencyDiff,
} from '../services/calendar-consistency.js';
import {
  buildConsistencyAlertEmail,
  shouldSendConsistencyAlert,
  type StaleHold,
} from '../services/consistency-alert-email.js';
import { sendEmail } from '../services/email-service.js';
import { config } from '../config/index.js';
import type { HostexReservation } from '../types/hostex.js';
import logger from '../utils/logger.js';

// Real Airbnb-iCal-Codes sind immer "HM…" (siehe reconcile-ical.ts) — der
// UID-Präfix-Fallback für owner-block-Events (kein Reservation-URL) ist NIE
// eine echte Reservierung und darf nie ein "missing" auslösen.
const HM_CODE_RE = /^HM[A-Z0-9]+$/;

/** "Heute" als YYYY-MM-DD in der übergebenen Zeitzone (wie reconcile-ical.ts). */
function todayInTimezone(timezone: string): string {
  const zoned = toZonedTime(new Date(), timezone);
  const yyyy = zoned.getFullYear();
  const mm = String(zoned.getMonth() + 1).padStart(2, '0');
  const dd = String(zoned.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function toGoogleEventLite(events: Array<{
  id?: string | null;
  summary?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
  extendedProperties?: { private?: Record<string, string> | null } | null;
}>): GoogleEventLite[] {
  return events
    .filter((e): e is typeof e & { id: string } => !!e.id)
    .map((e) => ({
      id: e.id,
      summary: e.summary ?? undefined,
      start: e.start ? { date: e.start.date ?? undefined, dateTime: e.start.dateTime ?? undefined } : undefined,
      end: e.end ? { date: e.end.date ?? undefined, dateTime: e.end.dateTime ?? undefined } : undefined,
      extendedProperties: e.extendedProperties?.private
        ? { private: e.extendedProperties.private }
        : undefined,
    }));
}

export interface SourceCounts {
  reservations: number;
  blockSpans: number;
}

// ─── Erwartungsbild pro Property (LIVE, am DB-Cache vorbei) ─────────────────

async function buildGuestyExpectedEvents(
  property: PropertyConfig,
  from: string,
  to: string
): Promise<{ events: ExpectedEvent[]; sourceCounts: SourceCounts }> {
  const listingId = getListingId(property);

  // Paginierung wie sync-inquiries.ts, pageSize 100.
  const pageSize = 100;
  const maxPages = 50;
  const allReservations: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch =
      (await guestyClient.getReservations({
        listingId,
        status: ['confirmed', 'reserved'],
        limit: pageSize,
        ...(page > 0 ? { skip: page * pageSize } : {}),
      })) ?? [];
    allReservations.push(...batch);
    if (batch.length < pageSize) break;
  }

  const reservationEvents: ExpectedEvent[] = [];
  for (const r of allReservations) {
    if (!r?._id) continue;
    const checkInDay: string | null =
      r.checkInDateLocalized || (typeof r.checkIn === 'string' ? r.checkIn.split('T')[0] : null);
    const checkOutDay: string | null =
      r.checkOutDateLocalized || (typeof r.checkOut === 'string' ? r.checkOut.split('T')[0] : null);
    if (!checkInDay || !checkOutDay) continue;

    const start = checkInDay;
    const endExclusive = addOneDay(checkOutDay);
    if (!overlapsWindow(start, endExclusive, from, to)) continue;

    reservationEvents.push({
      type: 'reservation',
      eventId: toGoogleEventId(r._id),
      reservationId: r._id,
      guestName: r.guest?.fullName ?? null,
      status: r.status,
      start,
      endExclusive,
    });
  }

  const calendar = await guestyClient.getCalendar(listingId, from, to);
  const availability = mapAvailabilityBatch(calendar);
  const spans = buildBlockSpans(
    availability.map((a) => ({ date: a.date, status: a.status, block_type: a.block_type }))
  );
  const blockEvents: ExpectedEvent[] = spans
    .filter((s) => overlapsWindow(s.startDate, s.endExclusive, from, to))
    .map((s) => ({
      type: 'block',
      eventId: blockEventId(listingId, s.startDate),
      start: s.startDate,
      endExclusive: s.endExclusive,
    }));

  return {
    events: [...reservationEvents, ...blockEvents],
    sourceCounts: { reservations: reservationEvents.length, blockSpans: blockEvents.length },
  };
}

async function buildHostexExpectedEvents(
  property: PropertyConfig,
  from: string,
  to: string
): Promise<{ events: ExpectedEvent[]; sourceCounts: SourceCounts }> {
  const hostexId = getListingId(property);
  const client = getHostexClient();
  const defaultTimes = {
    checkIn: property.googleCalendar?.checkInTime ?? '15:00',
    checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
  };

  const reservations = await client.getReservations({ propertyId: hostexId });

  const reservationEvents: ExpectedEvent[] = [];
  const activeRaw: HostexReservation[] = [];
  for (const r of reservations) {
    const { asReservation } = mapHostexReservation(r, defaultTimes);
    if (!asReservation) continue;
    activeRaw.push(r);

    const start = asReservation.check_in_localized ?? asReservation.check_in.split('T')[0];
    const endExclusive = addOneDay(asReservation.check_out_localized ?? asReservation.check_out.split('T')[0]);
    if (!overlapsWindow(start, endExclusive, from, to)) continue;

    reservationEvents.push({
      type: 'reservation',
      eventId: toGoogleEventId(asReservation.reservation_id),
      reservationId: asReservation.reservation_id,
      guestName: asReservation.guest_name,
      status: asReservation.status,
      start,
      endExclusive,
    });
  }

  let blockEvents: ExpectedEvent[] = [];
  const hostexProperties = await client.getProperties();
  const hostexProperty = hostexProperties.find((p) => String(p.id) === hostexId);
  const channel = hostexProperty?.channels?.[0];

  if (channel) {
    const calResp = await client.getListingCalendars({
      startDate: from,
      endDate: to,
      listings: [{ channel_type: channel.channel_type, listing_id: channel.listing_id }],
    });
    const listingCal = calResp.listings.find((l) => l.listing_id === channel.listing_id);
    if (listingCal) {
      const lastSyncedAt = new Date().toISOString();
      const rows = listingCal.calendar.map((day) =>
        mapHostexCalendarDay({
          day,
          listingId: hostexId,
          reservationsForDate: activeRaw.filter(
            (r) => r.check_in_date <= day.date && day.date < r.check_out_date
          ),
          lastSyncedAt,
        })
      );
      const spans = buildBlockSpans(
        rows.map((row) => ({ date: row.date, status: row.status, block_type: row.block_type }))
      );
      blockEvents = spans
        .filter((s) => overlapsWindow(s.startDate, s.endExclusive, from, to))
        .map((s) => ({
          type: 'block',
          eventId: blockEventId(hostexId, s.startDate),
          start: s.startDate,
          endExclusive: s.endExclusive,
        }));
    }
  } else {
    logger.warn(
      { propertySlug: property.slug, hostexId },
      'Consistency check: Hostex-Property ohne Channel — Block-Diff übersprungen'
    );
  }

  return {
    events: [...reservationEvents, ...blockEvents],
    sourceCounts: { reservations: reservationEvents.length, blockSpans: blockEvents.length },
  };
}

async function buildAirbnbExpectedEvents(
  property: PropertyConfig,
  from: string,
  to: string
): Promise<{ events: ExpectedEvent[]; sourceCounts: SourceCounts }> {
  const listingId = getListingId(property);
  const url = property.airbnbIcalUrl!;

  const ics = await fetchAirbnbIcal(url);
  const events = parseAirbnbIcal(ics);

  const listing = getListingById(listingId);
  const basePrice = listing?.base_price ?? 0;
  const minNights = listing?.min_nights ?? 1;

  const rows = buildAvailabilityRows({
    listingId,
    windowStart: from,
    windowEnd: to,
    events,
    basePrice,
    defaultMinNights: minNights,
    lastSyncedAt: new Date().toISOString(),
  });

  const bookedIntervals = groupBookedIntervals(rows.map((r) => ({ date: r.date, block_ref: r.block_ref })));
  const reservationEvents: ExpectedEvent[] = bookedIntervals
    .filter((iv) => HM_CODE_RE.test(iv.code))
    .map((iv) => {
      const start = iv.start;
      const endExclusive = addOneDay(iv.endExclusive);
      return { type: 'reservation' as const, eventId: toGoogleEventId(iv.code), reservationId: iv.code, guestName: null, status: 'confirmed', start, endExclusive };
    })
    .filter((e) => overlapsWindow(e.start, e.endExclusive, from, to));

  const spans = buildBlockSpans(rows.map((r) => ({ date: r.date, status: r.status, block_type: r.block_type })));
  const blockEvents: ExpectedEvent[] = spans
    .filter((s) => overlapsWindow(s.startDate, s.endExclusive, from, to))
    .map((s) => ({
      type: 'block',
      eventId: blockEventId(listingId, s.startDate),
      start: s.startDate,
      endExclusive: s.endExclusive,
    }));

  return {
    events: [...reservationEvents, ...blockEvents],
    sourceCounts: { reservations: reservationEvents.length, blockSpans: blockEvents.length },
  };
}

export async function buildExpectedEventsForProperty(
  property: PropertyConfig,
  from: string,
  to: string
): Promise<{ events: ExpectedEvent[]; sourceCounts: SourceCounts }> {
  if (property.provider === 'guesty') return buildGuestyExpectedEvents(property, from, to);
  if (property.provider === 'hostex') return buildHostexExpectedEvents(property, from, to);
  return buildAirbnbExpectedEvents(property, from, to);
}

// ─── Endpoint 1: Konsistenz-Check ───────────────────────────────────────────

export interface PropertyConsistencyResult {
  slug: string;
  name: string;
  provider: string;
  ok: boolean;
  sourceCounts: SourceCounts;
  googleEventCount: number;
  cacheLastSyncedAt: string | null;
  missing: ExpectedEvent[];
  extra: ConsistencyDiff['extra'];
  mismatched: ConsistencyDiff['mismatched'];
  error: string | null;
}

export interface ConsistencyReport {
  checkedAt: string;
  windowDays: number;
  from: string;
  to: string;
  totalIssues: number;
  properties: PropertyConsistencyResult[];
}

export async function runConsistencyCheck(days: number): Promise<ConsistencyReport> {
  const checkedAt = new Date().toISOString();
  const properties = getAllProperties().filter((p) => p.googleCalendar?.enabled && p.googleCalendar.calendarId);

  const reportFrom = todayInTimezone(config.propertyTimezone);
  const reportTo = addDays(reportFrom, days);

  const results: PropertyConsistencyResult[] = [];
  let totalIssues = 0;

  for (const property of properties) {
    const calendarId = property.googleCalendar!.calendarId!;
    const listingId = getListingId(property);
    const from = todayInTimezone(property.timezone);
    const to = addDays(from, days);

    try {
      const { events, sourceCounts } = await buildExpectedEventsForProperty(property, from, to);
      const googleEventsRaw = await googleCalendarClient.listEvents(calendarId, `${from}T00:00:00Z`, `${to}T00:00:00Z`);
      const googleEvents = toGoogleEventLite(googleEventsRaw as any);
      const diff = diffCalendarEvents(events, googleEvents, from, to);
      const issueCount = diff.missing.length + diff.extra.length + diff.mismatched.length;
      totalIssues += issueCount;

      results.push({
        slug: property.slug,
        name: property.name,
        provider: property.provider,
        ok: issueCount === 0,
        sourceCounts,
        googleEventCount: googleEvents.length,
        cacheLastSyncedAt: getAvailabilityLastSyncedAt(listingId),
        missing: diff.missing,
        extra: diff.extra,
        mismatched: diff.mismatched,
        error: null,
      });
    } catch (error) {
      totalIssues += 1;
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, propertySlug: property.slug }, 'Consistency check: Property fehlgeschlagen (non-fatal)');
      results.push({
        slug: property.slug,
        name: property.name,
        provider: property.provider,
        ok: false,
        sourceCounts: { reservations: 0, blockSpans: 0 },
        googleEventCount: 0,
        cacheLastSyncedAt: null,
        missing: [],
        extra: [],
        mismatched: [],
        error: message,
      });
    }
  }

  return { checkedAt, windowDays: days, from: reportFrom, to: reportTo, totalIssues, properties: results };
}

// ─── Endpoint 2: offene Reservierungen (Hold-Sweep) ─────────────────────────

export interface OpenReservation {
  provider: string;
  reservationId: string;
  property: { slug: string; name: string; code: string } | null;
  listingId: string;
  status: string;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  source: string | null;
  confirmationCode: string | null;
  createdAt: string;
}

function propertyBadge(property: PropertyConfig): { slug: string; name: string; code: string } {
  return { slug: property.slug, name: property.name, code: property.shortCode ?? property.slug };
}

async function listOpenGuestyReservations(statuses: string[], includePast: boolean, todayStr: string): Promise<OpenReservation[]> {
  const pageSize = 100;
  const maxPages = 50;
  const all: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch =
      (await guestyClient.getReservations({
        status: statuses,
        limit: pageSize,
        ...(page > 0 ? { skip: page * pageSize } : {}),
      })) ?? [];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }

  const out: OpenReservation[] = [];
  for (const r of all) {
    if (!r?._id || !r?.listingId) continue;
    const checkIn = r.checkInDateLocalized || (typeof r.checkIn === 'string' ? r.checkIn.split('T')[0] : null);
    const checkOut = r.checkOutDateLocalized || (typeof r.checkOut === 'string' ? r.checkOut.split('T')[0] : null);
    if (!checkIn || !checkOut) continue;
    if (!includePast && checkIn < todayStr) continue;

    const property = getPropertyByGuestyId(r.listingId);
    out.push({
      provider: 'guesty',
      reservationId: r._id,
      property: property ? propertyBadge(property) : null,
      listingId: r.listingId,
      status: r.status,
      guestName: r.guest?.fullName ?? null,
      checkIn,
      checkOut,
      source: r.source ?? null,
      confirmationCode: r.confirmationCode ?? null,
      createdAt: r.createdAt ?? checkIn,
    });
  }
  return out;
}

async function listOpenHostexReservations(statuses: string[], includePast: boolean, todayStr: string): Promise<OpenReservation[]> {
  const hostexProperties = getPropertiesByProvider('hostex');
  const client = getHostexClient();
  const out: OpenReservation[] = [];

  for (const property of hostexProperties) {
    const hostexId = getListingId(property);
    const defaultTimes = {
      checkIn: property.googleCalendar?.checkInTime ?? '15:00',
      checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
    };

    const reservations = await client.getReservations({ propertyId: hostexId });
    for (const r of reservations) {
      const { asInquiry } = mapHostexReservation(r, defaultTimes);
      if (!statuses.includes(asInquiry.status)) continue;
      if (!includePast && asInquiry.check_in < todayStr) continue;

      out.push({
        provider: 'hostex',
        reservationId: r.reservation_code,
        property: propertyBadge(property),
        listingId: hostexId,
        status: asInquiry.status,
        guestName: asInquiry.guest_name,
        checkIn: asInquiry.check_in,
        checkOut: asInquiry.check_out,
        source: asInquiry.source,
        confirmationCode: r.channel_id ?? null,
        createdAt: asInquiry.created_at_guesty ?? asInquiry.check_in,
      });
    }
  }
  return out;
}

export async function listOpenReservations(statuses: string[], includePast: boolean): Promise<OpenReservation[]> {
  const todayStr = todayInTimezone(config.propertyTimezone);
  const [guesty, hostex] = await Promise.all([
    listOpenGuestyReservations(statuses, includePast, todayStr),
    listOpenHostexReservations(statuses, includePast, todayStr),
  ]);
  return [...guesty, ...hostex].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ─── Täglicher Cron-Job: Check + Hold-Sweep + Alert ─────────────────────────

const STALE_HOLD_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_CHECK_WINDOW_DAYS = 28;

export async function runDailyConsistencyJob(): Promise<void> {
  const report = await runConsistencyCheck(DAILY_CHECK_WINDOW_DAYS);
  const openReservations = await listOpenReservations(['reserved', 'inquiry'], false);

  const now = Date.now();
  const staleHolds: StaleHold[] = openReservations
    .filter((r) => now - new Date(r.createdAt).getTime() > STALE_HOLD_THRESHOLD_MS)
    .map((r) => ({
      provider: r.provider,
      guestName: r.guestName,
      property: r.property ? { slug: r.property.slug, name: r.property.name } : null,
      checkIn: r.checkIn,
      createdAt: r.createdAt,
    }));

  if (!shouldSendConsistencyAlert(report, staleHolds)) {
    logger.info(
      { totalIssues: report.totalIssues, staleHolds: staleHolds.length },
      'Konsistenz-Check: keine Befunde, kein Alert'
    );
    return;
  }

  const recipients = config.consistencyAlertRecipients;
  if (recipients.length === 0) {
    logger.error(
      {
        totalIssues: report.totalIssues,
        staleHolds: staleHolds.length,
        affectedProperties: report.properties.filter((p) => !p.ok).map((p) => p.slug),
      },
      '🚨 Kalender-Konsistenz-Befund ohne konfigurierte Alert-Empfänger (CONSISTENCY_ALERT_RECIPIENTS) — siehe Logs für Details'
    );
    return;
  }

  const { subject, html, text } = buildConsistencyAlertEmail(report, staleHolds);
  const sent = await sendEmail({ to: recipients, subject, html, text });
  if (sent) {
    logger.info(
      { recipients: recipients.length, totalIssues: report.totalIssues, staleHolds: staleHolds.length },
      '✅ Konsistenz-Alert-Mail gesendet'
    );
  } else {
    logger.error({ totalIssues: report.totalIssues }, '❌ Konsistenz-Alert-Mail konnte nicht gesendet werden');
  }
}
