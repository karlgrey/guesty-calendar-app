/**
 * Hostex Sync Calendar
 *
 * Fetches 24 months of calendar data (12 back + 12 forward) for a property's
 * primary channel listing, looks up overlapping reservations from the DB,
 * and upserts availability rows.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { upsertAvailabilityBatch, deleteOldAvailability } from '../../repositories/availability-repository.js';
import { getReservationsInRange } from '../../repositories/reservation-repository.js';
import { mapHostexCalendarDay } from '../../mappers/hostex/calendar-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { HostexProperty, HostexReservation } from '../../types/hostex.js';

export interface SyncCalendarResult {
  success: boolean;
  daysCount: number;
  error?: string;
}

export async function syncHostexCalendar(
  property: PropertyConfig,
  hostexProperty: HostexProperty
): Promise<SyncCalendarResult> {
  const startTime = Date.now();
  const slug = property.slug;
  const listingId = String(hostexProperty.id);

  try {
    const channel = hostexProperty.channels[0];
    if (!channel) {
      throw new Error(`No channels configured for Hostex property ${listingId}`);
    }

    // Hostex constraint: start_date must be within 1 year of "now" (no past dates).
    // Calendar covers future availability/pricing — past reservations come from
    // /v3/reservations separately. We sync today → today+24 months.
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 24);
    const startStr = now.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    logger.info({ slug, listingId, startStr, endStr }, 'Hostex: starting calendar sync');

    const client = getHostexClient();
    const calResp = await client.getListingCalendars({
      startDate: startStr,
      endDate: endStr,
      listings: [{ channel_type: channel.channel_type, listing_id: channel.listing_id }],
    });

    const listingCal = calResp.listings.find((l) => l.listing_id === channel.listing_id);
    if (!listingCal) {
      throw new Error(`Calendar response missing for listing ${channel.listing_id}`);
    }

    // Load reservations for overlap detection
    const reservations = getReservationsInRange(listingId, startStr, endStr);
    // Build lookup: date → reservations[]
    const resByDate = new Map<string, HostexReservation[]>();
    for (const day of listingCal.calendar) {
      const overlapping = reservations.filter((r) => {
        // reservation.check_in / check_out are ISO strings — extract date
        const ci = (r.check_in_localized ?? r.check_in).split('T')[0];
        const co = (r.check_out_localized ?? r.check_out).split('T')[0];
        return ci <= day.date && day.date < co;
      });
      // Adapter: we have internal Reservation, but mapper expects HostexReservation.
      // Construct minimal HostexReservation shape for mapper's reservationsForDate usage.
      const hostexLike: HostexReservation[] = overlapping.map((r) => ({
        reservation_code: r.reservation_id,
        stay_code: r.reservation_id,
        channel_id: r.confirmation_code ?? '',
        channel_type: r.source ?? '',
        listing_id: r.listing_id,
        property_id: Number(r.listing_id),
        status: 'accepted',
        check_in_date: (r.check_in_localized ?? r.check_in).split('T')[0],
        check_out_date: (r.check_out_localized ?? r.check_out).split('T')[0],
      }));
      resByDate.set(day.date, hostexLike);
    }

    const lastSyncedAt = new Date().toISOString();
    const rows = listingCal.calendar.map((day) =>
      mapHostexCalendarDay({
        day,
        listingId,
        reservationsForDate: resByDate.get(day.date) ?? [],
        lastSyncedAt,
      })
    );

    upsertAvailabilityBatch(rows);

    // Cleanup tage außerhalb der Range
    const deleted = deleteOldAvailability(listingId, startStr);

    logger.info(
      { slug, daysCount: rows.length, deletedOld: deleted, durationMs: Date.now() - startTime },
      'Hostex: calendar sync completed'
    );

    return { success: true, daysCount: rows.length };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: calendar sync failed');
    return {
      success: false,
      daysCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
