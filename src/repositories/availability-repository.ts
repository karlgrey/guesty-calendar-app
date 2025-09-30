/**
 * Availability Repository
 *
 * Database operations for availability table.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { Availability, AvailabilityRow } from '../types/models.js';
import { rowToAvailability } from '../types/models.js';

/**
 * Insert or update a single availability record
 */
export function upsertAvailability(availability: Omit<Availability, 'id' | 'created_at' | 'updated_at'>): void {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO availability (
        listing_id, date, status, price, min_nights,
        closed_to_arrival, closed_to_departure, block_type, block_ref, last_synced_at
      ) VALUES (
        @listing_id, @date, @status, @price, @min_nights,
        @closed_to_arrival, @closed_to_departure, @block_type, @block_ref, @last_synced_at
      )
      ON CONFLICT(listing_id, date) DO UPDATE SET
        status = excluded.status,
        price = excluded.price,
        min_nights = excluded.min_nights,
        closed_to_arrival = excluded.closed_to_arrival,
        closed_to_departure = excluded.closed_to_departure,
        block_type = excluded.block_type,
        block_ref = excluded.block_ref,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    stmt.run({
      listing_id: availability.listing_id,
      date: availability.date,
      status: availability.status,
      price: availability.price,
      min_nights: availability.min_nights,
      closed_to_arrival: availability.closed_to_arrival ? 1 : 0,
      closed_to_departure: availability.closed_to_departure ? 1 : 0,
      block_type: availability.block_type,
      block_ref: availability.block_ref,
      last_synced_at: availability.last_synced_at,
    });
  } catch (error) {
    logger.error({ error, listingId: availability.listing_id, date: availability.date }, 'Failed to upsert availability');
    throw new DatabaseError(
      `Failed to upsert availability: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Batch insert/update availability records (uses transaction for performance)
 */
export function upsertAvailabilityBatch(
  availabilities: Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>>
): number {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO availability (
        listing_id, date, status, price, min_nights,
        closed_to_arrival, closed_to_departure, block_type, block_ref, last_synced_at
      ) VALUES (
        @listing_id, @date, @status, @price, @min_nights,
        @closed_to_arrival, @closed_to_departure, @block_type, @block_ref, @last_synced_at
      )
      ON CONFLICT(listing_id, date) DO UPDATE SET
        status = excluded.status,
        price = excluded.price,
        min_nights = excluded.min_nights,
        closed_to_arrival = excluded.closed_to_arrival,
        closed_to_departure = excluded.closed_to_departure,
        block_type = excluded.block_type,
        block_ref = excluded.block_ref,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    // Use transaction for batch operations
    const upsertMany = db.transaction((records: typeof availabilities) => {
      for (const availability of records) {
        stmt.run({
          listing_id: availability.listing_id,
          date: availability.date,
          status: availability.status,
          price: availability.price,
          min_nights: availability.min_nights,
          closed_to_arrival: availability.closed_to_arrival ? 1 : 0,
          closed_to_departure: availability.closed_to_departure ? 1 : 0,
          block_type: availability.block_type,
          block_ref: availability.block_ref,
          last_synced_at: availability.last_synced_at,
        });
      }
      return records.length;
    });

    const count = upsertMany(availabilities);

    logger.debug({ count, listingId: availabilities[0]?.listing_id }, 'Availability batch upserted');

    return count;
  } catch (error) {
    logger.error({ error, count: availabilities.length }, 'Failed to upsert availability batch');
    throw new DatabaseError(
      `Failed to upsert availability batch: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get availability for a listing in a date range
 */
export function getAvailability(listingId: string, startDate: string, endDate: string): Availability[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare(
        `SELECT * FROM availability
         WHERE listing_id = ?
         AND date >= ?
         AND date <= ?
         ORDER BY date ASC`
      )
      .all(listingId, startDate, endDate) as AvailabilityRow[];

    return rows.map(rowToAvailability);
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to get availability');
    throw new DatabaseError(
      `Failed to get availability: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get available dates (status = 'available') for a listing
 */
export function getAvailableDates(listingId: string, startDate: string, endDate: string): Availability[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare(
        `SELECT * FROM availability
         WHERE listing_id = ?
         AND date >= ?
         AND date <= ?
         AND status = 'available'
         ORDER BY date ASC`
      )
      .all(listingId, startDate, endDate) as AvailabilityRow[];

    return rows.map(rowToAvailability);
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to get available dates');
    throw new DatabaseError(
      `Failed to get available dates: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Check if all dates in range are available
 */
export function areDatesAvailable(listingId: string, checkIn: string, checkOut: string): boolean {
  const db = getDatabase();

  try {
    // Check-out date is exclusive (don't need to check it)
    const result = db
      .prepare(
        `SELECT COUNT(*) as count
         FROM availability
         WHERE listing_id = ?
         AND date >= ?
         AND date < ?
         AND (status != 'available' OR closed_to_arrival = 1)`
      )
      .get(listingId, checkIn, checkOut) as { count: number };

    return result.count === 0;
  } catch (error) {
    logger.error({ error, listingId, checkIn, checkOut }, 'Failed to check dates availability');
    throw new DatabaseError(
      `Failed to check dates availability: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Delete old availability records (older than specified date)
 */
export function deleteOldAvailability(listingId: string, beforeDate: string): number {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `DELETE FROM availability
         WHERE listing_id = ?
         AND date < ?`
      )
      .run(listingId, beforeDate);

    logger.debug({ listingId, beforeDate, deleted: result.changes }, 'Old availability records deleted');

    return result.changes;
  } catch (error) {
    logger.error({ error, listingId, beforeDate }, 'Failed to delete old availability');
    throw new DatabaseError(
      `Failed to delete old availability: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get date range of cached availability for a listing
 */
export function getAvailabilityDateRange(listingId: string): { minDate: string; maxDate: string } | null {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `SELECT MIN(date) as min_date, MAX(date) as max_date
         FROM availability
         WHERE listing_id = ?`
      )
      .get(listingId) as { min_date: string | null; max_date: string | null };

    if (!result.min_date || !result.max_date) {
      return null;
    }

    return {
      minDate: result.min_date,
      maxDate: result.max_date,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get availability date range');
    throw new DatabaseError(
      `Failed to get availability date range: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}