/**
 * Airbnb Payout Repository
 *
 * Ground-truth payout amounts parsed from Airbnb payout mails, plus the
 * payout_status flag on reservations ('confirmed' = exact, 'estimated' =
 * derived from booking mail or iCal, awaiting a payout mail).
 *
 * Deliberately NOT part of the Reservation TS model: payout_status is only
 * written here so Guesty/Hostex code paths stay untouched.
 */
import { getDatabase } from '../db/index.js';
import { r2 } from '../utils/airbnb-payout.js';

export interface PayoutItemRow {
  message_id: string;
  listing_id: string;
  reservation_code: string;
  payout_date: string;        // YYYY-MM-DD
  amount: number;             // net contribution of this mail to this reservation
  stay_start: string | null;  // YYYY-MM-DD from the payout line items
  stay_end: string | null;    // YYYY-MM-DD (check-out date as printed)
  total_mail_amount: number;
}

export function insertPayoutItems(items: PayoutItemRow[]): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO airbnb_payouts
      (message_id, listing_id, reservation_code, payout_date, amount, stay_start, stay_end, total_mail_amount)
    VALUES (@message_id, @listing_id, @reservation_code, @payout_date, @amount, @stay_start, @stay_end, @total_mail_amount)
  `);
  let inserted = 0;
  for (const it of items) inserted += stmt.run(it).changes;
  return inserted;
}

export function getPayoutSumByCode(reservationCode: string): { sum: number; count: number } {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS sum, COUNT(*) AS count FROM airbnb_payouts WHERE reservation_code = ?`
  ).get(reservationCode) as { sum: number; count: number };
  return { sum: r2(row.sum), count: row.count };
}

export function setReservationPayoutConfirmed(reservationCode: string, amount: number): void {
  getDatabase().prepare(
    `UPDATE reservations SET host_payout = ?, payout_status = 'confirmed' WHERE reservation_id = ?`
  ).run(r2(amount), reservationCode);
}

export function setPayoutStatus(reservationCode: string, status: 'confirmed' | 'estimated'): void {
  getDatabase().prepare(
    `UPDATE reservations SET payout_status = ? WHERE reservation_id = ?`
  ).run(status, reservationCode);
}

/**
 * Replace the DATE part of check_in/check_out, keep the stored time-of-day,
 * recompute nights_count. Used when payout mails / iCal report changed dates.
 */
export function updateReservationStay(reservationCode: string, checkInDate: string, checkOutDate: string): void {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT check_in, check_out FROM reservations WHERE reservation_id = ?`
  ).get(reservationCode) as { check_in: string; check_out: string } | undefined;
  if (!row) return;
  const timePart = (iso: string, fallback: string) => (iso && iso.includes('T') ? iso.slice(10) : fallback);
  const nights = Math.round(
    (Date.parse(`${checkOutDate}T00:00:00Z`) - Date.parse(`${checkInDate}T00:00:00Z`)) / 86_400_000
  );
  db.prepare(`
    UPDATE reservations SET
      check_in = ?, check_out = ?, check_in_localized = ?, check_out_localized = ?, nights_count = ?
    WHERE reservation_id = ?
  `).run(
    `${checkInDate}${timePart(row.check_in, 'T15:00:00.000Z')}`,
    `${checkOutDate}${timePart(row.check_out, 'T12:00:00.000Z')}`,
    checkInDate, checkOutDate, nights, reservationCode
  );
}

export function getEstimatedYearStats(listingId: string, year: number): { count: number; revenue: number } {
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(host_payout, total_price, 0)), 0) AS revenue
    FROM reservations
    WHERE listing_id = ? AND payout_status = 'estimated' AND check_in >= ? AND check_in < ?
  `).get(listingId, `${year}-01-01`, `${year + 1}-01-01`) as { count: number; revenue: number };
  return { count: row.count, revenue: r2(row.revenue) };
}

export function getUnmatchedPayouts(listingId: string): Array<{ reservation_code: string | null; payout_date: string; amount: number }> {
  return getDatabase().prepare(`
    SELECT p.reservation_code, p.payout_date, p.amount
    FROM airbnb_payouts p
    LEFT JOIN reservations r ON r.reservation_id = p.reservation_code
    WHERE p.listing_id = ? AND r.id IS NULL
    ORDER BY p.payout_date
  `).all(listingId) as Array<{ reservation_code: string | null; payout_date: string; amount: number }>;
}
