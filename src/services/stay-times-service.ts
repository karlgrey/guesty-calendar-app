/**
 * Zeit-Abweichungen pro Aufenthalt (#799) — EIN Service für Agent-API und Admin-Formular.
 *
 * Zusagen (Chat/Mail, Guesty UND Hostex) leben in unserer DB (`stay_time_overrides`,
 * Migration 035); der Kalender-Sync (`sync-google-calendar.ts`) macht daraus den Marker für
 * die Putzcrew. Guesty wird nur für den Folgetag-Block geschrieben (`next-day-block.ts`,
 * nur Objekte mit `blocksNextDayOnLateCheckout`). Keine Gebühren, keine Datums-/Personen-
 * änderung (dafür PATCH #792).
 */
import { findPropertyByListingId } from '../config/properties.js';
import { getReservationById } from '../repositories/reservation-repository.js';
import { getListingById } from '../repositories/listings-repository.js';
import {
  getOverride, upsertOverride, deleteOverride, type StayTimeOverride, type OverrideSource,
} from '../repositories/stay-time-override-repository.js';
import { effectiveTimes } from './effective-stay-times.js';
import { applyNextDayBlock, type NextDayBlockResult } from './next-day-block.js';
import { syncGoogleCalendarForProperty } from '../jobs/sync-google-calendar.js';
import { ACTIVE_RESERVATION_STATUSES } from '../repositories/reservation-repository.js';
import { berlinCalendarDay } from './auto-send/berlin-day.js';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors.js';
import type { Reservation } from '../types/models.js';
import logger from '../utils/logger.js';

export const STAY_TIMES_ALLOWED_FIELDS = ['plannedArrival', 'plannedDeparture', 'blockNextDay', 'note'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOTE_MAX = 500;

export interface StayTimesInput {
  plannedArrival?: string | null;
  plannedDeparture?: string | null;
  blockNextDay?: boolean;
  note?: string | null;
}

export interface OverrideView {
  plannedArrival: string | null;
  plannedDeparture: string | null;
  blockNextDay: boolean;
  note: string | null;
  source: OverrideSource;
  updatedAt: string;
}

export interface TimesView {
  effectiveArrival: string | null;
  effectiveDeparture: string | null;
  arrivalSource: 'override' | 'provider' | 'default' | null;
  departureSource: 'override' | 'provider' | 'default' | null;
  providerArrival: string | null;
  providerDeparture: string | null;
  listingDefaultArrival: string | null;
  listingDefaultDeparture: string | null;
  override: OverrideView | null;
}

export interface StayTimesView {
  reservationId: string;
  provider: string | null;
  propertySlug: string | null;
  /** Objekt hat das Flag `blocksNextDayOnLateCheckout` (Admin zeigt dann die Checkbox) */
  blocksNextDay: boolean;
  checkIn: string;
  checkOut: string;
  status: string;
  times: TimesView;
}

export interface StayTimesOptions {
  /** nur für Tests (YYYY-MM-DD, Europe/Berlin) */
  today?: string;
}

export interface StayTimesResult {
  ok: true;
  reservationId: string;
  times: TimesView;
  nextDayBlock: Omit<NextDayBlockResult, 'error'>;
  calendarSynced: boolean;
  /** gesetzt, wenn der Kalender-Sync nicht lief/scheiterte */
  calendarSync?: string;
  /** Guesty-Fehler beim Folgetag-Block — Aufrufer macht daraus 409 (Override ist trotzdem gespeichert) */
  blockError?: { message: string; details?: unknown };
}

const day = (localized: string | null, raw: string): string => (localized || raw).split('T')[0];

function validate(body: unknown): StayTimesInput {
  const list = STAY_TIMES_ALLOWED_FIELDS.join(', ');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(`Body muss ein JSON-Objekt sein — erlaubt: ${list}`);
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !(STAY_TIMES_ALLOWED_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new ValidationError(`Unbekannte Felder: ${unknown.join(', ')} — erlaubt: ${list}`);
  if (Object.keys(b).length === 0) throw new ValidationError(`Body ist leer — mindestens ein Feld aus: ${list}`);
  const out: StayTimesInput = {};
  for (const f of ['plannedArrival', 'plannedDeparture'] as const) {
    if (b[f] === undefined) continue;
    if (b[f] !== null && (typeof b[f] !== 'string' || !TIME_RE.test(b[f] as string))) {
      throw new ValidationError(`${f} must be HH:MM (00:00–23:59) oder null`);
    }
    out[f] = b[f] as string | null;
  }
  if (b.blockNextDay !== undefined) {
    if (typeof b.blockNextDay !== 'boolean') throw new ValidationError('blockNextDay muss true/false sein');
    out.blockNextDay = b.blockNextDay;
  }
  if (b.note !== undefined) {
    if (b.note !== null && typeof b.note !== 'string') throw new ValidationError('note muss ein String oder null sein');
    if (typeof b.note === 'string' && b.note.length > NOTE_MAX) throw new ValidationError(`note darf höchstens ${NOTE_MAX} Zeichen haben`);
    out.note = typeof b.note === 'string' && b.note.trim() === '' ? null : (b.note as string | null);
  }
  return out;
}

function overrideView(o: StayTimeOverride | null): OverrideView | null {
  return o
    ? {
        plannedArrival: o.plannedArrival, plannedDeparture: o.plannedDeparture, blockNextDay: o.blockNextDay,
        note: o.note, source: o.source, updatedAt: o.updatedAt,
      }
    : null;
}

/** Listing-Standard wie im Kalender-Sync: Listing (Provider) vor googleCalendar-Konfig. */
function listingDefaults(listingId: string): { checkIn: string | null; checkOut: string | null } {
  const listing = getListingById(listingId);
  const gc = findPropertyByListingId(listingId)?.googleCalendar;
  return {
    checkIn: listing?.check_in_time || gc?.checkInTime || null,
    checkOut: listing?.check_out_time || gc?.checkOutTime || null,
  };
}

function timesView(r: Reservation, override: StayTimeOverride | null): TimesView {
  const e = effectiveTimes(r, override, listingDefaults(r.listing_id));
  return {
    effectiveArrival: e.effectiveArrival,
    effectiveDeparture: e.effectiveDeparture,
    arrivalSource: e.arrivalSource,
    departureSource: e.departureSource,
    providerArrival: e.providerArrival,
    providerDeparture: e.providerDeparture,
    listingDefaultArrival: e.defaultArrival,
    listingDefaultDeparture: e.defaultDeparture,
    override: overrideView(override),
  };
}

/** Nur lokale Daten, beide Provider. `null` ohne lokale Reservierungszeile. */
export function getStayTimes(reservationId: string): StayTimesView | null {
  const r = getReservationById(reservationId);
  if (!r) return null;
  const property = findPropertyByListingId(r.listing_id);
  return {
    reservationId: r.reservation_id,
    provider: property?.provider ?? null,
    propertySlug: property?.slug ?? null,
    blocksNextDay: !!property?.blocksNextDayOnLateCheckout,
    checkIn: day(r.check_in_localized, r.check_in),
    checkOut: day(r.check_out_localized, r.check_out),
    status: r.status,
    times: timesView(r, getOverride(reservationId)),
  };
}

function requireEditable(reservationId: string, opts: StayTimesOptions): Reservation {
  const r = getReservationById(reservationId);
  if (!r) throw new NotFoundError(`Reservierung ${reservationId} ist lokal nicht bekannt`);
  if (!(ACTIVE_RESERVATION_STATUSES as readonly string[]).includes(r.status)) {
    throw new ConflictError(`Reservierung im Status '${r.status}' — Zeit-Abweichung nur bei ${ACTIVE_RESERVATION_STATUSES.join('/')}`);
  }
  const today = opts.today ?? berlinCalendarDay(new Date().toISOString());
  const checkOut = day(r.check_out_localized, r.check_out);
  if (checkOut < today) {
    throw new ConflictError(`Check-out ${checkOut} liegt in der Vergangenheit (heute ${today}) — keine Zeit-Abweichung mehr möglich`);
  }
  return r;
}

async function syncCalendar(r: Reservation): Promise<{ calendarSynced: boolean; calendarSync?: string }> {
  const property = findPropertyByListingId(r.listing_id);
  if (!property?.googleCalendar?.enabled) return { calendarSynced: false, calendarSync: 'Objekt ohne aktiven Google-Kalender' };
  try {
    const res = await syncGoogleCalendarForProperty(property);
    if (res.success) return { calendarSynced: true };
    logger.warn({ reservationId: r.reservation_id, error: res.error }, 'Kalender-Sync nach Zeit-Abweichung fehlgeschlagen (non-fatal)');
  } catch (error) {
    logger.warn({ error, reservationId: r.reservation_id }, 'Kalender-Sync nach Zeit-Abweichung geworfen (non-fatal)');
  }
  return { calendarSynced: false, calendarSync: 'nächster Lauf' };
}

function blockTarget(r: Reservation) {
  return {
    reservationId: r.reservation_id,
    listingId: r.listing_id,
    source: r.source,
    checkOutDay: day(r.check_out_localized, r.check_out),
  };
}

function splitBlock(b: NextDayBlockResult): Pick<StayTimesResult, 'nextDayBlock' | 'blockError'> {
  const { error, ...rest } = b;
  return { nextDayBlock: rest, ...(error ? { blockError: error } : {}) };
}

/** PUT-Semantik: Teilmenge, `null` = Feld zurück auf Provider-/Standardwert. */
export async function setStayTimes(
  reservationId: string,
  body: unknown,
  source: OverrideSource,
  opts: StayTimesOptions = {},
): Promise<StayTimesResult> {
  const input = validate(body);
  const r = requireEditable(reservationId, opts);
  const previous = getOverride(reservationId);

  const saved = upsertOverride({ reservationId, ...input, source });
  logger.info({ reservationId, source, fields: Object.keys(input) }, 'Zeit-Abweichung gespeichert');

  let block: Pick<StayTimesResult, 'nextDayBlock' | 'blockError'> = {
    nextDayBlock: { applied: false, method: 'none', reason: 'blockNextDay nicht angefragt' },
  };
  // Nur bei ausdrücklichem blockNextDay und wenn sich dadurch etwas bei Guesty ändern kann
  // (anlegen, oder eine zuvor gesetzte Sperre aufheben) — sonst kein externer Aufruf.
  if (input.blockNextDay !== undefined && (input.blockNextDay || previous?.blockNextDay)) {
    block = splitBlock(await applyNextDayBlock(blockTarget(r), input.blockNextDay));
  } else if (input.blockNextDay !== undefined) {
    block = { nextDayBlock: { applied: false, method: 'none', reason: 'kein Folgetag-Block gesetzt' } };
  } else if (!findPropertyByListingId(r.listing_id)?.blocksNextDayOnLateCheckout) {
    block = { nextDayBlock: { applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag' } };
  }

  const cal = await syncCalendar(r);
  return {
    ok: true,
    reservationId,
    times: timesView(r, saved),
    ...block,
    ...cal,
  };
}

/** DELETE: Override löschen UND gesetzten Folgetag-Block aufheben. Scheitert die Aufhebung, bleibt der Override (Retry). */
export async function deleteStayTimes(reservationId: string, opts: StayTimesOptions = {}): Promise<StayTimesResult> {
  const r = requireEditable(reservationId, opts);
  const existing = getOverride(reservationId);
  if (!existing) throw new NotFoundError(`Keine Zeit-Abweichung für Reservierung ${reservationId}`);

  let block: Pick<StayTimesResult, 'nextDayBlock' | 'blockError'> = {
    nextDayBlock: { applied: false, method: 'none', reason: 'kein Folgetag-Block gesetzt' },
  };
  if (existing.blockNextDay) {
    block = splitBlock(await applyNextDayBlock(blockTarget(r), false));
    if (block.blockError) {
      logger.warn({ reservationId }, 'Folgetag-Block nicht aufgehoben — Override bleibt bestehen');
      return { ok: true, reservationId, times: timesView(r, existing), ...block, calendarSynced: false, calendarSync: 'Override unverändert' };
    }
  }
  deleteOverride(reservationId);
  logger.info({ reservationId }, 'Zeit-Abweichung gelöscht');
  const cal = await syncCalendar(r);
  return { ok: true, reservationId, times: timesView(r, null), ...block, ...cal };
}
