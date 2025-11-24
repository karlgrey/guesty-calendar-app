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

/**
 * Sync all inquiries and reservations from Guesty API
 *
 * Fetches ALL reservation statuses (inquiry, confirmed, reserved, canceled, declined)
 * to enable accurate conversion rate tracking
 */
export async function syncInquiries(listingId: string): Promise<SyncInquiriesResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId }, 'Starting inquiry sync from Guesty API');

    // Fetch ALL reservations from Guesty API (no status filter = all statuses)
    const allReservations = await guestyClient.getReservations({
      listingId,
      limit: 1000, // Fetch up to 1000 reservations
    });

    logger.info(
      { count: allReservations.length, listingId },
      'Fetched reservations from Guesty API'
    );

    // Count by status
    const inquiries = allReservations.filter((r: any) => r.status === 'inquiry');
    const confirmed = allReservations.filter((r: any) =>
      r.status === 'confirmed' || r.status === 'reserved'
    );

    // Upsert to inquiries table
    const now = new Date().toISOString();
    const db = getDatabase();

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

    const upsertMany = db.transaction((reservations: any[]) => {
      for (const r of reservations) {
        // Skip if missing required fields
        if (!r._id || !r.listingId || !r.status || !r.checkIn || !r.checkOut) {
          logger.debug({ reservation: r._id }, 'Skipping reservation with missing required fields');
          continue;
        }

        // Extract guest name from guest object
        const guestName = r.guest?.fullName || r.guest?.firstName || 'Unknown';

        // Use checkInDateLocalized if available, otherwise parse checkIn
        const checkInDate = r.checkInDateLocalized || r.checkIn?.split('T')[0] || r.checkIn;
        const checkOutDate = r.checkOutDateLocalized || r.checkOut?.split('T')[0] || r.checkOut;

        upsertStmt.run(
          r._id,
          r.listingId,
          r.status,
          checkInDate,
          checkOutDate,
          guestName,
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
