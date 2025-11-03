/**
 * Reservation Repository
 *
 * Database operations for reservations table.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { Reservation, ReservationRow } from '../types/models.js';
import { rowToReservation } from '../types/models.js';

/**
 * Insert or update a single reservation record
 */
export function upsertReservation(
  reservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'>
): void {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO reservations (
        reservation_id, listing_id, check_in, check_out,
        check_in_localized, check_out_localized, nights_count,
        guest_id, guest_name, guests_count, adults_count, children_count, infants_count,
        status, confirmation_code, source, platform,
        planned_arrival, planned_departure,
        currency, total_price, host_payout, balance_due, total_paid,
        created_at_guesty, reserved_at, last_synced_at
      ) VALUES (
        @reservation_id, @listing_id, @check_in, @check_out,
        @check_in_localized, @check_out_localized, @nights_count,
        @guest_id, @guest_name, @guests_count, @adults_count, @children_count, @infants_count,
        @status, @confirmation_code, @source, @platform,
        @planned_arrival, @planned_departure,
        @currency, @total_price, @host_payout, @balance_due, @total_paid,
        @created_at_guesty, @reserved_at, @last_synced_at
      )
      ON CONFLICT(reservation_id) DO UPDATE SET
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        check_in_localized = excluded.check_in_localized,
        check_out_localized = excluded.check_out_localized,
        nights_count = excluded.nights_count,
        guest_id = excluded.guest_id,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        adults_count = excluded.adults_count,
        children_count = excluded.children_count,
        infants_count = excluded.infants_count,
        status = excluded.status,
        confirmation_code = excluded.confirmation_code,
        source = excluded.source,
        platform = excluded.platform,
        planned_arrival = excluded.planned_arrival,
        planned_departure = excluded.planned_departure,
        currency = excluded.currency,
        total_price = excluded.total_price,
        host_payout = excluded.host_payout,
        balance_due = excluded.balance_due,
        total_paid = excluded.total_paid,
        created_at_guesty = excluded.created_at_guesty,
        reserved_at = excluded.reserved_at,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    stmt.run(reservation);
  } catch (error) {
    logger.error({ error, reservationId: reservation.reservation_id }, 'Failed to upsert reservation');
    throw new DatabaseError(
      `Failed to upsert reservation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Batch insert/update reservation records (uses transaction for performance)
 */
export function upsertReservationBatch(
  reservations: Array<Omit<Reservation, 'id' | 'created_at' | 'updated_at'>>
): number {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO reservations (
        reservation_id, listing_id, check_in, check_out,
        check_in_localized, check_out_localized, nights_count,
        guest_id, guest_name, guests_count, adults_count, children_count, infants_count,
        status, confirmation_code, source, platform,
        planned_arrival, planned_departure,
        currency, total_price, host_payout, balance_due, total_paid,
        created_at_guesty, reserved_at, last_synced_at
      ) VALUES (
        @reservation_id, @listing_id, @check_in, @check_out,
        @check_in_localized, @check_out_localized, @nights_count,
        @guest_id, @guest_name, @guests_count, @adults_count, @children_count, @infants_count,
        @status, @confirmation_code, @source, @platform,
        @planned_arrival, @planned_departure,
        @currency, @total_price, @host_payout, @balance_due, @total_paid,
        @created_at_guesty, @reserved_at, @last_synced_at
      )
      ON CONFLICT(reservation_id) DO UPDATE SET
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        check_in_localized = excluded.check_in_localized,
        check_out_localized = excluded.check_out_localized,
        nights_count = excluded.nights_count,
        guest_id = excluded.guest_id,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        adults_count = excluded.adults_count,
        children_count = excluded.children_count,
        infants_count = excluded.infants_count,
        status = excluded.status,
        confirmation_code = excluded.confirmation_code,
        source = excluded.source,
        platform = excluded.platform,
        planned_arrival = excluded.planned_arrival,
        planned_departure = excluded.planned_departure,
        currency = excluded.currency,
        total_price = excluded.total_price,
        host_payout = excluded.host_payout,
        balance_due = excluded.balance_due,
        total_paid = excluded.total_paid,
        created_at_guesty = excluded.created_at_guesty,
        reserved_at = excluded.reserved_at,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    // Use transaction for batch operations
    const upsertMany = db.transaction((records: typeof reservations) => {
      for (const reservation of records) {
        stmt.run(reservation);
      }
      return records.length;
    });

    const count = upsertMany(reservations);

    logger.debug({ count, listingId: reservations[0]?.listing_id }, 'Reservations batch upserted');

    return count;
  } catch (error) {
    logger.error({ error, count: reservations.length }, 'Failed to upsert reservation batch');
    throw new DatabaseError(
      `Failed to upsert reservation batch: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get a reservation by ID
 */
export function getReservationById(reservationId: string): Reservation | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare('SELECT * FROM reservations WHERE reservation_id = ?')
      .get(reservationId) as ReservationRow | undefined;

    return row ? rowToReservation(row) : null;
  } catch (error) {
    logger.error({ error, reservationId }, 'Failed to get reservation');
    throw new DatabaseError(
      `Failed to get reservation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get all upcoming reservations for a listing
 */
export function getUpcomingReservations(listingId: string): Reservation[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare(
        `SELECT * FROM reservations
         WHERE listing_id = ?
         AND check_in >= date('now')
         ORDER BY check_in ASC`
      )
      .all(listingId) as ReservationRow[];

    return rows.map(rowToReservation);
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get upcoming reservations');
    throw new DatabaseError(
      `Failed to get upcoming reservations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get reservations by period (past or future)
 */
export function getReservationsByPeriod(
  listingId: string,
  days: number = 365,
  period: 'past' | 'future' = 'future'
): Reservation[] {
  const db = getDatabase();

  try {
    let query: string;
    let params: any[];

    if (period === 'past') {
      // Past reservations (check-out date in the past)
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];

      query = `SELECT * FROM reservations
               WHERE listing_id = ?
               AND check_out >= ?
               AND check_out < date('now')
               ORDER BY check_out DESC`;
      params = [listingId, startDateStr];
    } else {
      // Future reservations (check-in date in the future)
      query = `SELECT * FROM reservations
               WHERE listing_id = ?
               AND check_in >= date('now')
               ORDER BY check_in ASC`;
      params = [listingId];
    }

    const rows = db.prepare(query).all(...params) as ReservationRow[];

    return rows.map(rowToReservation);
  } catch (error) {
    logger.error({ error, listingId, days, period }, 'Failed to get reservations by period');
    throw new DatabaseError(
      `Failed to get reservations by period: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get reservations in a date range
 */
export function getReservationsInRange(
  listingId: string,
  startDate: string,
  endDate: string
): Reservation[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare(
        `SELECT * FROM reservations
         WHERE listing_id = ?
         AND check_in <= ?
         AND check_out >= ?
         ORDER BY check_in ASC`
      )
      .all(listingId, endDate, startDate) as ReservationRow[];

    return rows.map(rowToReservation);
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to get reservations in range');
    throw new DatabaseError(
      `Failed to get reservations in range: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Delete old reservations (check-out before specified date)
 */
export function deleteOldReservations(listingId: string, beforeDate: string): number {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `DELETE FROM reservations
         WHERE listing_id = ?
         AND check_out < ?`
      )
      .run(listingId, beforeDate);

    logger.debug({ listingId, beforeDate, deleted: result.changes }, 'Old reservations deleted');

    return result.changes;
  } catch (error) {
    logger.error({ error, listingId, beforeDate }, 'Failed to delete old reservations');
    throw new DatabaseError(
      `Failed to delete old reservations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
