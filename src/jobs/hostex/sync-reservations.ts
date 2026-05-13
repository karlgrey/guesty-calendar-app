/**
 * Hostex Sync Reservations
 *
 * Fetches all reservations for a Hostex property and persists them.
 * - All statuses → `inquiries` table (BI history pool)
 * - Active (accepted, wait_pay, unknown→reserved-defensive) → `reservations` table
 * - Stale reservations no longer in API are deleted from `reservations`
 *
 * Note: `inquiries` table is never cleaned up — analogous to Guesty sync.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { getDatabase } from '../../db/index.js';
import {
  upsertReservation,
  deleteStaleReservationsInRange,
} from '../../repositories/reservation-repository.js';
import { mapHostexReservation } from '../../mappers/hostex/reservation-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncResult {
  success: boolean;
  inquiriesCount: number;
  confirmedCount: number;
  error?: string;
}

export async function syncHostexReservations(property: PropertyConfig): Promise<SyncResult> {
  const startTime = Date.now();
  const hostexId = property.hostexPropertyId!;
  const slug = property.slug;

  try {
    logger.info({ slug, hostexId }, 'Hostex: starting reservation sync');

    const client = getHostexClient();
    const reservations = await client.getReservations({ propertyId: hostexId });

    logger.info({ slug, count: reservations.length }, 'Hostex: fetched reservations');

    const defaultTimes = {
      checkIn: property.googleCalendar?.checkInTime ?? '15:00',
      checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
    };

    const db = getDatabase();
    const upsertInquiry = db.prepare(`
      INSERT INTO inquiries (
        inquiry_id, listing_id, status, check_in, check_out,
        guest_name, guests_count, source, created_at_guesty, last_synced_at
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

    let inquiriesCount = 0;
    let confirmedCount = 0;
    const keepReservationIds: string[] = [];

    const upsertAll = db.transaction((items: typeof reservations) => {
      for (const r of items) {
        const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
        upsertInquiry.run(
          asInquiry.inquiry_id,
          asInquiry.listing_id,
          asInquiry.status,
          asInquiry.check_in,
          asInquiry.check_out,
          asInquiry.guest_name,
          asInquiry.guests_count,
          asInquiry.source,
          asInquiry.created_at_guesty,
          asInquiry.last_synced_at,
        );
        inquiriesCount++;
        if (asReservation) {
          upsertReservation(asReservation);
          if (asReservation.status === 'confirmed') confirmedCount++;
          keepReservationIds.push(asReservation.reservation_id);
        }
      }
    });
    upsertAll(reservations);

    // Cleanup stale reservations in 24-month window (past 12 + future 12)
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    const end = new Date(now);
    end.setMonth(end.getMonth() + 12);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const deleted = deleteStaleReservationsInRange(hostexId, startStr, endStr, keepReservationIds);

    logger.info(
      { slug, inquiriesCount, confirmedCount, deletedStale: deleted, durationMs: Date.now() - startTime },
      'Hostex: reservation sync completed'
    );

    return { success: true, inquiriesCount, confirmedCount };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: reservation sync failed');
    return {
      success: false,
      inquiriesCount: 0,
      confirmedCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
