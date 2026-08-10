/**
 * Airbnb iCal Reconciliation
 *
 * Cross-checks `reservations` against the availability calendar synced from
 * Airbnb's private iCal feed (sync-ical.ts writes booked days with
 * block_type='reservation', block_ref=<HM-code>). The calendar is the
 * ground truth for DATES (booking mails miss real alteration dates; the
 * iCal always reflects the current state), while payout mails
 * (payout-applier.ts) are the ground truth for AMOUNTS.
 *
 * Three jobs:
 *  1. Correct stay dates when a reservation's stored dates drifted from the
 *     calendar (moved/extended/shortened bookings). In-progress stays keep
 *     their stored check-in — iCal only carries FUTURE availability, so past
 *     nights are pruned from it and must not be (mis-)read as "check-in
 *     moved forward".
 *  2. Create a placeholder reservation for iCal-only bookings that never
 *     produced a parseable booking mail (e.g. the confirmation mail was
 *     lost/unparseable) — marked 'estimated' unless a payout mail already
 *     arrived for that code.
 *  3. Report future mail/iCal reservations that vanished from the calendar
 *     (likely cancellations whose mail we never saw) as a data-quality
 *     warning — never auto-deleted, that stays a human decision.
 */
import { getDatabase } from '../../db/index.js';
import { getReservationById, upsertReservation } from '../../repositories/reservation-repository.js';
import {
  getPayoutSumByCode,
  setReservationPayoutConfirmed,
  setPayoutStatus,
  updateReservationStay,
} from '../../repositories/airbnb-payout-repository.js';
import { getListingById } from '../../repositories/listings-repository.js';
import { computeEffectivePayout } from '../../utils/airbnb-payout.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface ReconcileResult {
  updated: string[];
  created: string[];
  missingInIcal: string[];
}

interface BookedInterval {
  code: string;
  start: string; // YYYY-MM-DD, inclusive
  endExclusive: string; // YYYY-MM-DD, exclusive (= check-out date)
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function nightsBetween(start: string, endExclusive: string): number {
  return Math.round(
    (Date.parse(`${endExclusive}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  );
}

/**
 * Groups consecutive booked days sharing the same block_ref into stay
 * intervals. A gap in dates or a change of block_ref ends the current
 * interval, even if the ref reappears later (re-booking after a cancel).
 */
export function groupBookedIntervals(
  rows: Array<{ date: string; block_ref: string | null }>
): BookedInterval[] {
  const result: BookedInterval[] = [];
  let current: { code: string; start: string; last: string } | null = null;

  for (const row of rows) {
    if (!row.block_ref) {
      if (current) {
        result.push({ code: current.code, start: current.start, endExclusive: addOneDay(current.last) });
        current = null;
      }
      continue;
    }
    if (current && current.code === row.block_ref && addOneDay(current.last) === row.date) {
      current.last = row.date;
    } else {
      if (current) {
        result.push({ code: current.code, start: current.start, endExclusive: addOneDay(current.last) });
      }
      current = { code: row.block_ref, start: row.date, last: row.date };
    }
  }
  if (current) {
    result.push({ code: current.code, start: current.start, endExclusive: addOneDay(current.last) });
  }
  return result;
}

function getBookedIntervals(listingId: string): BookedInterval[] {
  const rows = getDatabase()
    .prepare(
      `SELECT date, block_ref FROM availability
       WHERE listing_id = ? AND block_type = 'reservation' AND status = 'booked'
       ORDER BY date`
    )
    .all(listingId) as Array<{ date: string; block_ref: string | null }>;
  return groupBookedIntervals(rows);
}

/** Scales a reservation's host_payout proportionally to a nights_count change. */
function scaleReservationPayout(reservationCode: string, oldNights: number, newNights: number): void {
  if (oldNights <= 0) return;
  const db = getDatabase();
  const row = db
    .prepare(`SELECT host_payout FROM reservations WHERE reservation_id = ?`)
    .get(reservationCode) as { host_payout: number | null } | undefined;
  if (!row || row.host_payout == null) return;
  const scaled = r2((row.host_payout / oldNights) * newNights);
  db.prepare(`UPDATE reservations SET host_payout = ? WHERE reservation_id = ?`).run(scaled, reservationCode);
}

export function reconcileAirbnbReservations(
  property: PropertyConfig,
  todayStr: string = new Date().toISOString().slice(0, 10)
): ReconcileResult {
  const listingId = property.airbnbListingId!;
  const intervals = getBookedIntervals(listingId);
  const result: ReconcileResult = { updated: [], created: [], missingInIcal: [] };

  const defaultCheckIn = property.googleCalendar?.checkInTime ?? '15:00';
  const defaultCheckOut = property.googleCalendar?.checkOutTime ?? '12:00';

  for (const interval of intervals) {
    const code = interval.code;
    const reservation = getReservationById(code);

    if (reservation) {
      // In-progress stays: iCal only carries FUTURE days (sync-ical prunes the
      // past), so a stored check-in before today must NOT be pulled forward —
      // that would misread "past nights pruned" as "guest checked in later".
      const canMoveCheckIn = (reservation.check_in_localized ?? '') >= todayStr;
      const targetCheckIn = canMoveCheckIn ? interval.start : reservation.check_in_localized ?? interval.start;
      const targetCheckOut = interval.endExclusive;

      const changed =
        targetCheckIn !== reservation.check_in_localized || targetCheckOut !== reservation.check_out_localized;

      if (changed) {
        const oldNights = reservation.nights_count;
        updateReservationStay(code, targetCheckIn, targetCheckOut);

        if (getPayoutSumByCode(code).count === 0) {
          // No ground-truth payout yet — keep/flip to estimated and scale the
          // amount proportionally so the report isn't wildly off until the
          // payout mail arrives.
          const newNights = nightsBetween(targetCheckIn, targetCheckOut);
          setPayoutStatus(code, 'estimated');
          scaleReservationPayout(code, oldNights, newNights);
        }
        result.updated.push(code);
      }
      continue;
    }

    // iCal-only booking: no reservation row exists (booking mail lost/unparseable).
    // Create a placeholder so occupancy + revenue reporting still sees it.
    const nights = nightsBetween(interval.start, interval.endExclusive);
    const basePrice = getListingById(listingId)?.base_price ?? 0;
    const cleaningFee = property.static?.cleaningFee ?? 0;
    const brutto = nights * basePrice + cleaningFee;
    const now = new Date().toISOString();

    upsertReservation({
      reservation_id: code,
      listing_id: listingId,
      check_in: `${interval.start}T${defaultCheckIn}:00.000Z`,
      check_out: `${interval.endExclusive}T${defaultCheckOut}:00.000Z`,
      check_in_localized: interval.start,
      check_out_localized: interval.endExclusive,
      nights_count: nights,
      guest_id: null,
      guest_name: 'Airbnb-Gast (aus Kalender)',
      guests_count: null,
      adults_count: null,
      children_count: null,
      infants_count: null,
      status: 'confirmed',
      confirmation_code: code,
      source: 'airbnb',
      platform: 'airbnb-ical',
      planned_arrival: null,
      planned_departure: null,
      currency: 'EUR',
      total_price: brutto,
      host_payout: computeEffectivePayout(
        { hostPayoutBrutto: brutto, cleaningFee, totalPrice: brutto, occupancyTax: 0 },
        { coHostShareRate: property.static?.coHostShareRate, incomeTaxRate: property.static?.incomeTaxRate }
      ).hostPayoutEffective,
      balance_due: null,
      total_paid: null,
      created_at_guesty: now,
      reserved_at: now,
      last_synced_at: now,
      internal_guest_id: null,
      guest_company: null,
    });

    const existingPayout = getPayoutSumByCode(code);
    if (existingPayout.count > 0) {
      setReservationPayoutConfirmed(code, existingPayout.sum);
    } else {
      setPayoutStatus(code, 'estimated');
    }
    result.created.push(code);
  }

  result.missingInIcal = findReservationsMissingInIcal(listingId, todayStr);

  logger.info({ listingId, ...result }, 'Airbnb iCal reconciliation result');
  return result;
}

/**
 * Confirmed future reservations (from booking mail or a prior iCal
 * placeholder) that no longer have a matching booked interval in the
 * calendar — a likely cancellation whose mail we never saw. Reported only,
 * never auto-deleted (that stays a human decision).
 */
export function findReservationsMissingInIcal(listingId: string, todayStr: string): string[] {
  const db = getDatabase();
  const intervalCodes = new Set(getBookedIntervals(listingId).map((i) => i.code));

  const rows = db
    .prepare(
      `SELECT reservation_id FROM reservations
       WHERE listing_id = ? AND platform IN ('airbnb-mail','airbnb-ical')
         AND check_in_localized >= ? AND status = 'confirmed'`
    )
    .all(listingId, todayStr) as Array<{ reservation_id: string }>;

  return rows.map((r) => r.reservation_id).filter((id) => !intervalCodes.has(id));
}
