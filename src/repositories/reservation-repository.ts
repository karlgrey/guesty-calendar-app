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

      // Use date() function to normalize check_out which may have timezone info
      query = `SELECT * FROM reservations
               WHERE listing_id = ?
               AND date(check_out) >= ?
               AND date(check_out) < date('now')
               AND status IN ('confirmed', 'reserved')
               ORDER BY check_out DESC`;
      params = [listingId, startDateStr];
    } else {
      // Future reservations (check-in date in the future)
      // Only show confirmed/reserved, not canceled/declined
      // Use date() function to normalize check_in which may have timezone info
      query = `SELECT * FROM reservations
               WHERE listing_id = ?
               AND date(check_in) >= date('now')
               AND status IN ('confirmed', 'reserved')
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
 * Get cancelled/declined reservation IDs (for Google Calendar cleanup).
 * Queries the inquiries table since cancelled reservations are deleted from the reservations table.
 */
export function getCancelledReservationIds(
  listingId: string,
  pastDays: number = 180,
  futureDays: number = 365
): string[] {
  const db = getDatabase();

  try {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - pastDays);
    const pastDateStr = pastDate.toISOString().split('T')[0];

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + futureDays);
    const futureDateStr = futureDate.toISOString().split('T')[0];

    const query = `SELECT inquiry_id FROM inquiries
                   WHERE listing_id = ?
                   AND date(check_in) >= ?
                   AND date(check_in) <= ?
                   AND status IN ('canceled', 'cancelled', 'declined')
                   ORDER BY check_in ASC`;

    const rows = db.prepare(query).all(listingId, pastDateStr, futureDateStr) as Array<{ inquiry_id: string }>;
    return rows.map(r => r.inquiry_id);
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get cancelled reservation IDs');
    throw new DatabaseError(
      `Failed to get cancelled reservation IDs: ${error instanceof Error ? error.message : 'Unknown error'}`
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
    // Use date() function to normalize check_in/check_out which may have timezone info
    const rows = db
      .prepare(
        `SELECT * FROM reservations
         WHERE listing_id = ?
         AND date(check_in) <= ?
         AND date(check_out) >= ?
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
    // Use date() function to normalize check_out which may have timezone info
    const result = db
      .prepare(
        `DELETE FROM reservations
         WHERE listing_id = ?
         AND date(check_out) < ?`
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

/**
 * Delete reservations that are no longer in the API response (cancelled/removed)
 * Removes reservations in the given date range that are not in the keepReservationIds list
 * Also deletes associated documents to avoid foreign key constraint violations
 */
export function deleteStaleReservationsInRange(
  listingId: string,
  startDate: string,
  endDate: string,
  keepReservationIds: string[]
): number {
  const db = getDatabase();

  try {
    // First, find the reservation IDs that will be deleted
    let findQuery: string;
    let findParams: any[];

    if (keepReservationIds.length === 0) {
      findQuery = `SELECT reservation_id FROM reservations
                   WHERE listing_id = ?
                   AND date(check_in) <= ?
                   AND date(check_out) >= ?`;
      findParams = [listingId, endDate, startDate];
    } else {
      const placeholders = keepReservationIds.map(() => '?').join(',');
      findQuery = `SELECT reservation_id FROM reservations
                   WHERE listing_id = ?
                   AND date(check_in) <= ?
                   AND date(check_out) >= ?
                   AND reservation_id NOT IN (${placeholders})`;
      findParams = [listingId, endDate, startDate, ...keepReservationIds];
    }

    const staleReservations = db.prepare(findQuery).all(...findParams) as { reservation_id: string }[];

    if (staleReservations.length === 0) {
      return 0;
    }

    const staleIds = staleReservations.map(r => r.reservation_id);

    // Use a transaction to delete documents first, then reservations
    const deleteStale = db.transaction(() => {
      // Delete associated documents first (to avoid FK constraint)
      const docPlaceholders = staleIds.map(() => '?').join(',');
      const docResult = db.prepare(
        `DELETE FROM documents WHERE reservation_id IN (${docPlaceholders})`
      ).run(...staleIds);

      if (docResult.changes > 0) {
        logger.info({ deletedDocuments: docResult.changes }, 'Deleted documents for stale reservations');
      }

      // Now delete the reservations
      const resResult = db.prepare(
        `DELETE FROM reservations WHERE reservation_id IN (${docPlaceholders})`
      ).run(...staleIds);

      return resResult.changes;
    });

    const deletedCount = deleteStale();

    if (deletedCount > 0) {
      logger.info(
        {
          listingId,
          startDate,
          endDate,
          deletedCount,
          keptCount: keepReservationIds.length,
        },
        'Deleted stale/cancelled reservations from range'
      );
    }

    return deletedCount;
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to delete stale reservations');
    throw new DatabaseError(
      `Failed to delete stale reservations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
