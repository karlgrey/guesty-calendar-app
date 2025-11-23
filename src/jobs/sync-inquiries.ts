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
 */
export async function syncInquiries(listingId: string): Promise<SyncInquiriesResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId }, 'Starting inquiry sync');

    // Fetch all reservations including inquiries
    // Statuses: inquiry, confirmed, reserved, canceled, declined, closed
    const allReservations = await guestyClient.getReservations({
      listingId,
      limit: 100, // API max is 100
    });

    logger.info(
      { count: allReservations.length, listingId },
      'Fetched reservations from Guesty'
    );

    // Count by status
    const inquiries = allReservations.filter((r: GuestyReservation) => r.status === 'inquiry');
    const confirmed = allReservations.filter((r: GuestyReservation) =>
      r.status === 'confirmed' || r.status === 'reserved'
    );

    // Store in database
    const db = getDatabase();
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

    const upsertMany = db.transaction((reservations: GuestyReservation[]) => {
      for (const r of reservations) {
        // Skip if missing required fields
        if (!r._id || !r.listingId || !r.status || !r.checkIn || !r.checkOut) {
          logger.debug({ reservation: r._id }, 'Skipping reservation with missing required fields');
          continue;
        }

        const guestName = r.guest?.fullName ||
          (r.guest?.firstName || r.guest?.lastName
            ? `${r.guest.firstName || ''} ${r.guest.lastName || ''}`.trim()
            : 'Unknown');

        upsertStmt.run(
          r._id,
          r.listingId,
          r.status,
          r.checkIn,
          r.checkOut,
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
