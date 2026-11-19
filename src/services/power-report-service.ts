/**
 * Stromverbrauch je Buchung (#1169) — lädt Buchungen + Zählerstände eines Objekts und
 * rechnet über `computePowerRows` (pure). Quelle der An-/Abreisezeit: dieselbe wie
 * `GET /api/agent/reservations/:id/times` (`getStayTimes`: Override vor Provider-Feld vor
 * Listing-Standard), Rückfall auf `checkInTime`/`checkOutTime` aus properties.json.
 */
import { fromZonedTime } from 'date-fns-tz';
import { getDatabase } from '../db/index.js';
import { getListingId, getPropertyBySlug, type PropertyConfig } from '../config/properties.js';
import { getStayTimes } from './stay-times-service.js';
import { getLatestMeterReading, getMeterReadings, type MeterReading } from '../repositories/meter-reading-repository.js';
import { computePowerRows, MAX_INTERPOLATION_GAP_MS, type PowerComputation, type StayInput } from './power-consumption.js';
import { NotFoundError } from '../utils/errors.js';

/** Auswertungsfenster: Buchungen, deren Check-out höchstens 12 Monate zurückliegt. */
export const REPORT_MONTHS = 12;

export interface PowerReport extends PowerComputation {
  propertySlug: string;
  propertyName: string;
  timezone: string;
  /** jüngster empfangener Stand (nach Messzeitpunkt), null = noch nie geliefert */
  latestReading: MeterReading | null;
  generatedAt: string;
}

interface StayRow {
  reservation_id: string;
  guest_name: string | null;
  check_in: string;
  check_out: string;
  check_in_localized: string | null;
  check_out_localized: string | null;
  nights_count: number;
}

const day = (localized: string | null, raw: string): string => (localized || raw).split('T')[0];

/** Lokales Datum + HH:MM in der Objekt-Zeitzone → UTC-ISO. */
export function localToUtc(date: string, time: string | null, timezone: string): string {
  const hhmm = (time ?? '00:00').slice(0, 5);
  return fromZonedTime(`${date}T${hhmm}:00`, timezone).toISOString();
}

/** Nur bestätigte Buchungen (keine stornierten, keine Holds `reserved`; Blocker liegen nicht in `reservations`). */
function loadStays(property: PropertyConfig, fromDate: string, now: Date): StayInput[] {
  const listingId = getListingId(property);
  const rows = getDatabase()
    .prepare(
      `SELECT reservation_id, guest_name, check_in, check_out, check_in_localized, check_out_localized, nights_count
       FROM reservations
       WHERE listing_id = ? AND status = 'confirmed'
         AND date(COALESCE(check_out_localized, check_out)) >= ?
         AND date(COALESCE(check_in_localized, check_in)) <= ?
       ORDER BY check_in ASC`,
    )
    .all(listingId, fromDate, now.toISOString().slice(0, 10)) as StayRow[];
  return rows.map((r) => {
    const checkInDate = day(r.check_in_localized, r.check_in);
    const checkOutDate = day(r.check_out_localized, r.check_out);
    const times = getStayTimes(r.reservation_id)?.times;
    const arrival = times?.effectiveArrival ?? property.checkInTime ?? null;
    const departure = times?.effectiveDeparture ?? property.checkOutTime ?? null;
    return {
      reservationId: r.reservation_id,
      guestName: r.guest_name,
      checkInDate,
      checkOutDate,
      nights: r.nights_count,
      startUtc: localToUtc(checkInDate, arrival, property.timezone),
      endUtc: localToUtc(checkOutDate, departure, property.timezone),
    };
  });
}

export function buildPowerReport(propertySlug: string, now: Date = new Date()): PowerReport {
  const property = getPropertyBySlug(propertySlug);
  if (!property) throw new NotFoundError(`Objekt ${propertySlug} ist nicht konfiguriert`);
  const from = new Date(now);
  from.setMonth(from.getMonth() - REPORT_MONTHS);
  const stays = loadStays(property, from.toISOString().slice(0, 10), now);
  const earliest = stays.length ? Math.min(...stays.map((s) => Date.parse(s.startUtc))) : now.getTime();
  const readings = getMeterReadings(
    property.slug,
    new Date(earliest - MAX_INTERPOLATION_GAP_MS).toISOString(),
    // bis „unendlich“: der nächste Check-in eines laufenden Leerstands kann in der Zukunft liegen
    '9999-12-31T23:59:59.999Z',
  );
  const computed = computePowerRows(stays, readings, now.getTime());
  return {
    ...computed,
    propertySlug: property.slug,
    propertyName: property.name,
    timezone: property.timezone,
    latestReading: getLatestMeterReading(property.slug),
    generatedAt: now.toISOString(),
  };
}
