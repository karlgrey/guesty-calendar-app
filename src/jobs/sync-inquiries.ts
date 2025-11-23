/**
 * Sync Inquiries Job
 *
 * Fetches all inquiries and reservations from Guesty API to track conversion rates
 */

import { guestyClient } from '../services/guesty-client.js';
import logger from '../utils/logger.js';
import { getDatabase } from '../db/index.js';

export interface SyncInquiriesResult {
  success: boolean;
  inquiriesCount: number;
  confirmedCount: number;
  error?: string;
}

interface GuestyReservation {
  _id: string;
  listingId: string;
  status: string;
  checkIn: string;
  checkOut: string;
  checkInDateLocalized?: string;
  checkOutDateLocalized?: string;
  guest?: {
    _id?: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
  };
  guestsCount?: number;
  source?: string;
  createdAt?: string;
  confirmedAt?: string;
}

/**
 * Sync all inquiries and reservations from Guesty
 *
 * Note: We use the reservations table data (from calendar endpoint)
 * since the /reservations API endpoint requires special permissions
 */
export async function syncInquiries(listingId: string): Promise<SyncInquiriesResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId }, 'Starting inquiry sync');

    // Get reservations from local database (already synced from calendar endpoint)
    const db = getDatabase();
    const allReservations = db
      .prepare(
        `SELECT
          reservation_id as _id,
          listing_id as listingId,
          status,
          check_in as checkIn,
          check_out as checkOut,
          guest_name as guestName,
          guests_count as guestsCount,
          source,
          created_at as createdAt
        FROM reservations
        WHERE listing_id = ?`
      )
      .all(listingId) as Array<{
        _id: string;
        listingId: string;
        status: string;
        checkIn: string;
        checkOut: string;
        guestName: string;
        guestsCount: number;
        source: string | null;
        createdAt: string;
      }>;

    logger.info(
      { count: allReservations.length, listingId },
      'Fetched reservations from local database'
    );

    // Count by status
    const inquiries = allReservations.filter((r) => r.status === 'inquiry');
    const confirmed = allReservations.filter((r) =>
      r.status === 'confirmed' || r.status === 'reserved'
    );

    // Upsert to inquiries table
    const now = new Date().toISOString();

    // Upsert each reservation/inquiry
    const upsertStmt = db.prepare(`
      INSERT INTO inquiries (
        inquiry_id,
        listing_id,
        status,
        check_in,
        check_out,
        guest_name,
        guests_count,
        source,
        created_at_guesty,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inquiry_id) DO UPDATE SET
        status = excluded.status,
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        source = excluded.source,
        last_synced_at = excluded.last_synced_at
    `);

    const upsertMany = db.transaction((reservations: typeof allReservations) => {
      for (const r of reservations) {
        // Skip if missing required fields
        if (!r._id || !r.listingId || !r.status || !r.checkIn || !r.checkOut) {
          logger.debug({ reservation: r._id }, 'Skipping reservation with missing required fields');
          continue;
        }

        upsertStmt.run(
          r._id,
          r.listingId,
          r.status,
          r.checkIn,
          r.checkOut,
          r.guestName || 'Unknown',
          r.guestsCount || 0,
          r.source || null,
          r.createdAt || now,
          now
        );
      }
    });

    upsertMany(allReservations);

    const duration = Date.now() - startTime;

    logger.info(
      {
        listingId,
        totalCount: allReservations.length,
        inquiriesCount: inquiries.length,
        confirmedCount: confirmed.length,
        duration,
      },
      'Inquiry sync completed successfully'
    );

    return {
      success: true,
      inquiriesCount: inquiries.length,
      confirmedCount: confirmed.length,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Inquiry sync failed');
    return {
      success: false,
      inquiriesCount: 0,
      confirmedCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
