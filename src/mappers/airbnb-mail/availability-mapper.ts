/**
 * Airbnb Availability Mapper
 *
 * Builds per-day Availability rows for a window, marking booked days from
 * iCal events. Price/min_nights come from the property's listing config
 * (Airbnb iCal has none).
 */

import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';
import type { Availability } from '../../types/models.js';

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Airbnb iCal blocks (owner/host "not available") vs guest reservations. */
function isBlockEvent(summary: string): boolean {
  return /not available/i.test(summary);
}

export function buildAvailabilityRows(args: {
  listingId: string;
  windowStart: string; // YYYY-MM-DD, inclusive
  windowEnd: string;   // YYYY-MM-DD, exclusive
  events: AirbnbIcalEvent[];
  basePrice: number;
  defaultMinNights: number;
  lastSyncedAt: string;
}): Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> {
  const { listingId, windowStart, windowEnd, events, basePrice, defaultMinNights, lastSyncedAt } = args;

  const rows: Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> = [];
  let day = windowStart;
  while (day < windowEnd) {
    const event = events.find((e) => e.startDate <= day && day < e.endDate);
    const isBlock = event ? isBlockEvent(event.summary) : false;
    rows.push({
      listing_id: listingId,
      date: day,
      status: event ? (isBlock ? 'blocked' : 'booked') : 'available',
      price: basePrice,
      min_nights: defaultMinNights,
      closed_to_arrival: false,
      closed_to_departure: false,
      block_type: event ? (isBlock ? 'owner' : 'reservation') : null,
      block_ref: event && !isBlock ? event.reservationCode : null,
      last_synced_at: lastSyncedAt,
    });
    day = addDays(day, 1);
  }
  return rows;
}
