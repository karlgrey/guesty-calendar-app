/**
 * Hostex Calendar Mapper
 *
 * Maps a Hostex calendar day to the internal Availability model. Status is
 * derived from inventory + overlapping reservations.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import type { HostexCalendarDay, HostexReservation } from '../../types/hostex.js';
import type { Availability } from '../../types/models.js';

export function mapHostexCalendarDay(args: {
  day: HostexCalendarDay;
  listingId: string;
  reservationsForDate: HostexReservation[];
  lastSyncedAt: string;
}): Omit<Availability, 'id' | 'created_at' | 'updated_at'> {
  const { day, listingId, reservationsForDate, lastSyncedAt } = args;

  let status: 'available' | 'blocked' | 'booked';
  let blockType: Availability['block_type'] = null;
  let blockRef: string | null = null;

  if (reservationsForDate.length > 0) {
    status = 'booked';
    blockType = 'reservation';
    blockRef = reservationsForDate[0].reservation_code;
  } else if (day.inventory === 0) {
    status = 'blocked';
  } else {
    status = 'available';
  }

  return {
    listing_id: listingId,
    date: day.date,
    status,
    price: day.price,
    min_nights: day.restrictions.min_stay_on_arrival,
    closed_to_arrival: day.restrictions.closed_on_arrival,
    closed_to_departure: day.restrictions.closed_on_departure,
    block_type: blockType,
    block_ref: blockRef,
    last_synced_at: lastSyncedAt,
  };
}
