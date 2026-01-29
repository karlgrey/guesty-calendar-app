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

/**
 * Booking/Reservation summary
 */
export interface BookingSummary {
  reservationId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalPrice: number;
  status: 'booked' | 'blocked';
  blockType?: string;
}

/**
 * Get all current and future bookings grouped by reservation
 */
export function getUpcomingBookings(listingId: string): BookingSummary[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare(
        `SELECT
          block_ref as reservation_id,
          MIN(date) as check_in,
          MAX(date) as check_out,
          COUNT(*) as nights,
          SUM(price) as total_price,
          status,
          block_type
        FROM availability
        WHERE listing_id = ?
        AND (status = 'booked' OR status = 'blocked')
        AND block_ref IS NOT NULL
        AND date >= date('now')
        GROUP BY block_ref
        ORDER BY check_in ASC`
      )
      .all(listingId) as Array<{
        reservation_id: string;
        check_in: string;
        check_out: string;
        nights: number;
        total_price: number;
        status: 'booked' | 'blocked';
        block_type: string | null;
      }>;

    return rows.map((row) => ({
      reservationId: row.reservation_id,
      checkIn: row.check_in,
      checkOut: row.check_out,
      nights: row.nights,
      totalPrice: row.total_price,
      status: row.status,
      blockType: row.block_type || undefined,
    }));
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get upcoming bookings');
    throw new DatabaseError(
      `Failed to get upcoming bookings: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Dashboard statistics
 */
export interface DashboardStats {
  totalBookings: number;
  totalRevenue: number;
  availableDays: number;
  bookedDays: number;
  blockedDays: number;
  occupancyRate: number;
}

/**
 * All-time statistics
 */
export interface AllTimeStats {
  totalBookings: number;
  totalRevenue: number;
  totalBookedDays: number;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Get dashboard statistics for the next N days
 */
export function getDashboardStats(
  listingId: string,
  days: number = 365,
  period: 'past' | 'future' = 'future'
): DashboardStats {
  const db = getDatabase();

  try {
    let startDateStr: string;
    let endDateStr: string;

    if (period === 'past') {
      // Last N days
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDateStr = startDate.toISOString().split('T')[0];
      endDateStr = new Date().toISOString().split('T')[0];
    } else {
      // Next N days (future)
      startDateStr = new Date().toISOString().split('T')[0];
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + days);
      endDateStr = endDate.toISOString().split('T')[0];
    }

    // Get availability stats (available, booked, blocked days)
    const availStats = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available_days,
          SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked_days,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked_days,
          COUNT(*) as total_days
        FROM availability
        WHERE listing_id = ?
        AND date >= ?
        AND date <= ?`
      )
      .get(listingId, startDateStr, endDateStr) as {
        available_days: number;
        booked_days: number;
        blocked_days: number;
        total_days: number;
      };

    // Get revenue from reservations table using host_payout (includes fees and taxes)
    let revenueQuery: string;
    let revenueParams: any[];

    if (period === 'past') {
      // Past reservations: check-out date in the range
      revenueQuery = `SELECT
        COUNT(*) as total_bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as total_revenue
      FROM reservations
      WHERE listing_id = ?
      AND check_out >= ?
      AND check_out < date('now')`;
      revenueParams = [listingId, startDateStr];
    } else {
      // Future reservations: check-in date in the range
      revenueQuery = `SELECT
        COUNT(*) as total_bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as total_revenue
      FROM reservations
      WHERE listing_id = ?
      AND check_in >= date('now')`;
      revenueParams = [listingId];
    }

    const revenueStats = db.prepare(revenueQuery).get(...revenueParams) as {
      total_bookings: number;
      total_revenue: number;
    };

    const occupancyRate = availStats.total_days > 0 ? (availStats.booked_days / availStats.total_days) * 100 : 0;

    return {
      totalBookings: revenueStats.total_bookings || 0,
      totalRevenue: revenueStats.total_revenue || 0,
      availableDays: availStats.available_days,
      bookedDays: availStats.booked_days,
      blockedDays: availStats.blocked_days,
      occupancyRate: Math.round(occupancyRate * 10) / 10, // Round to 1 decimal
    };
  } catch (error) {
    logger.error({ error, listingId, days, period }, 'Failed to get dashboard stats');
    throw new DatabaseError(
      `Failed to get dashboard stats: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get all-time statistics (all reservations ever)
 */
export function getAllTimeStats(listingId: string): AllTimeStats {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get all-time revenue stats from reservations
    const revenueStats = db
      .prepare(
        `SELECT
          COUNT(*) as total_bookings,
          SUM(COALESCE(host_payout, total_price, 0)) as total_revenue,
          SUM(nights_count) as total_booked_days,
          MIN(check_in) as start_date
        FROM reservations
        WHERE listing_id = ?`
      )
      .get(listingId) as {
        total_bookings: number;
        total_revenue: number;
        total_booked_days: number;
        start_date: string | null;
      };

    return {
      totalBookings: revenueStats.total_bookings || 0,
      totalRevenue: revenueStats.total_revenue || 0,
      totalBookedDays: revenueStats.total_booked_days || 0,
      startDate: revenueStats.start_date,
      endDate: today,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get all-time stats');
    throw new DatabaseError(
      `Failed to get all-time stats: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Calculate occupancy rate for a date range
 * Returns percentage of booked/blocked days vs total days
 */
export function getOccupancyRate(listingId: string, startDate: string, endDate: string): number {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `SELECT
          COUNT(*) as total_days,
          SUM(CASE WHEN status IN ('booked', 'blocked') THEN 1 ELSE 0 END) as occupied_days
        FROM availability
        WHERE listing_id = ?
          AND date >= ?
          AND date < ?`
      )
      .get(listingId, startDate, endDate) as {
        total_days: number;
        occupied_days: number;
      };

    if (result.total_days === 0) {
      return 0;
    }

    return Math.round((result.occupied_days / result.total_days) * 100);
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to get occupancy rate');
    throw new DatabaseError(
      `Failed to get occupancy rate: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Calculate inquiry to booking conversion rate for a date range
 * Returns percentage and counts
 */
export function getConversionRate(listingId: string, startDate: string, endDate: string): {
  inquiriesCount: number;
  confirmedCount: number;
  conversionRate: number;
} {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'inquiry' THEN 1 ELSE 0 END) as inquiries_count,
          SUM(CASE WHEN status IN ('confirmed', 'reserved') THEN 1 ELSE 0 END) as confirmed_count,
          COUNT(*) as total_count
        FROM inquiries
        WHERE listing_id = ?
          AND created_at_guesty >= ?
          AND created_at_guesty < ?`
      )
      .get(listingId, startDate, endDate) as {
        inquiries_count: number;
        confirmed_count: number;
        total_count: number;
      };

    const inquiriesCount = result.inquiries_count || 0;
    const confirmedCount = result.confirmed_count || 0;
    const total = inquiriesCount + confirmedCount;

    // Calculate conversion rate: (confirmed / (inquiries + confirmed)) * 100
    const conversionRate = total > 0 ? Math.round((confirmedCount / total) * 100) : 0;

    return {
      inquiriesCount,
      confirmedCount,
      conversionRate,
    };
  } catch (error) {
    logger.error({ error, listingId, startDate, endDate }, 'Failed to get conversion rate');
    // Return zeros if table doesn't exist yet
    return {
      inquiriesCount: 0,
      confirmedCount: 0,
      conversionRate: 0,
    };
  }
}

/**
 * Calculate all-time inquiry to booking conversion rate
 * Returns percentage and counts for all inquiries ever
 */
export function getAllTimeConversionRate(listingId: string): {
  inquiriesCount: number;
  confirmedCount: number;
  declinedCount: number;
  canceledCount: number;
  totalCount: number;
  conversionRate: number;
} {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'inquiry' THEN 1 ELSE 0 END) as inquiries_count,
          SUM(CASE WHEN status IN ('confirmed', 'reserved') THEN 1 ELSE 0 END) as confirmed_count,
          SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) as declined_count,
          SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) as canceled_count,
          COUNT(*) as total_count
        FROM inquiries
        WHERE listing_id = ?`
      )
      .get(listingId) as {
        inquiries_count: number;
        confirmed_count: number;
        declined_count: number;
        canceled_count: number;
        total_count: number;
      };

    const inquiriesCount = result.inquiries_count || 0;
    const confirmedCount = result.confirmed_count || 0;
    const declinedCount = result.declined_count || 0;
    const canceledCount = result.canceled_count || 0;
    const totalCount = result.total_count || 0;

    // Calculate conversion rate: confirmed bookings / total reservations
    // This shows what % of all inquiries/bookings convert to confirmed bookings
    const conversionRate = totalCount > 0 ? Math.round((confirmedCount / totalCount) * 100) : 0;

    return {
      inquiriesCount,
      confirmedCount,
      declinedCount,
      canceledCount,
      totalCount,
      conversionRate,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get all-time conversion rate');
    // Return zeros if table doesn't exist yet
    return {
      inquiriesCount: 0,
      confirmedCount: 0,
      declinedCount: 0,
      canceledCount: 0,
      totalCount: 0,
      conversionRate: 0,
    };
  }
}

/**
 * Current year revenue stats
 */
export interface CurrentYearStats {
  totalBookings: number;
  totalRevenue: number;
  totalBookedDays: number;
  year: number;
}

/**
 * Get current year statistics (bookings and revenue for current calendar year)
 */
export function getCurrentYearStats(listingId: string): CurrentYearStats {
  const db = getDatabase();
  const currentYear = new Date().getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  try {
    const result = db
      .prepare(
        `SELECT
          COUNT(*) as total_bookings,
          SUM(COALESCE(host_payout, total_price, 0)) as total_revenue,
          SUM(nights_count) as total_booked_days
        FROM reservations
        WHERE listing_id = ?
          AND check_in >= ?
          AND check_in <= ?`
      )
      .get(listingId, yearStart, yearEnd) as {
        total_bookings: number;
        total_revenue: number;
        total_booked_days: number;
      };

    return {
      totalBookings: result.total_bookings || 0,
      totalRevenue: result.total_revenue || 0,
      totalBookedDays: result.total_booked_days || 0,
      year: currentYear,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get current year stats');
    throw new DatabaseError(
      `Failed to get current year stats: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Monthly booking comparison
 */
export interface MonthlyBookingComparison {
  currentMonth: {
    bookings: number;
    revenue: number;
    nights: number;
    label: string;
  };
  previousMonth: {
    bookings: number;
    revenue: number;
    nights: number;
    label: string;
  };
  change: {
    bookings: number;
    revenue: number;
    nights: number;
  };
}

/**
 * Get bookings comparison: last 30 days vs previous 30 days
 */
export function getMonthlyBookingComparison(listingId: string): MonthlyBookingComparison {
  const db = getDatabase();
  const today = new Date();

  // Last 30 days
  const last30End = today;
  const last30Start = new Date(today);
  last30Start.setDate(last30Start.getDate() - 29); // 30 days including today

  // 30 days before that
  const prev30End = new Date(last30Start);
  prev30End.setDate(prev30End.getDate() - 1);
  const prev30Start = new Date(prev30End);
  prev30Start.setDate(prev30Start.getDate() - 29);

  const formatDate = (d: Date) => d.toISOString().split('T')[0];

  try {
    const currentResult = db.prepare(`
      SELECT
        COUNT(*) as bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as revenue,
        SUM(nights_count) as nights
      FROM reservations
      WHERE listing_id = ?
        AND check_in >= ?
        AND check_in <= ?
    `).get(listingId, formatDate(last30Start), formatDate(last30End)) as {
      bookings: number;
      revenue: number;
      nights: number;
    };

    const prevResult = db.prepare(`
      SELECT
        COUNT(*) as bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as revenue,
        SUM(nights_count) as nights
      FROM reservations
      WHERE listing_id = ?
        AND check_in >= ?
        AND check_in <= ?
    `).get(listingId, formatDate(prev30Start), formatDate(prev30End)) as {
      bookings: number;
      revenue: number;
      nights: number;
    };

    // Calculate percentage change
    const calcChange = (current: number, previous: number): number => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    return {
      currentMonth: {
        bookings: currentResult.bookings || 0,
        revenue: currentResult.revenue || 0,
        nights: currentResult.nights || 0,
        label: 'Last 30 Days',
      },
      previousMonth: {
        bookings: prevResult.bookings || 0,
        revenue: prevResult.revenue || 0,
        nights: prevResult.nights || 0,
        label: 'Previous 30 Days',
      },
      change: {
        bookings: calcChange(currentResult.bookings || 0, prevResult.bookings || 0),
        revenue: calcChange(currentResult.revenue || 0, prevResult.revenue || 0),
        nights: calcChange(currentResult.nights || 0, prevResult.nights || 0),
      },
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get monthly booking comparison');
    throw new DatabaseError(
      `Failed to get monthly booking comparison: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}