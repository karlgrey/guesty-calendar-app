/**
 * Availability Mapper
 *
 * Maps Guesty API calendar responses to internal availability records.
 * See docs/DATA_MODEL.md for field mapping documentation.
 */

import type { GuestyCalendarDay } from '../types/guesty';
import type { Availability, AvailabilityStatus, BlockType } from '../types/models';

/**
 * Determine availability status from Guesty calendar day
 *
 * Handles both single-unit and multi-unit properties.
 */
export function mapStatus(guestyDay: GuestyCalendarDay): AvailabilityStatus {
  // Handle multi-unit properties (check allotment first)
  const isAvailable =
    typeof guestyDay.allotment === 'number'
      ? guestyDay.allotment > 0
      : guestyDay.status === 'available';

  if (!isAvailable) {
    // Check if it's a reservation/booking (blocks.b flag)
    if (guestyDay.blocks?.b) {
      return 'booked';
    }
    return 'blocked';
  }

  return 'available';
}

/**
 * Extract block type from Guesty blocks object
 */
export function getBlockType(blocks?: GuestyCalendarDay['blocks']): BlockType {
  if (!blocks) return null;
  if (blocks.b) return 'reservation';  // b flag = booking/reservation
  if (blocks.o) return 'owner';        // o flag = owner block
  if (blocks.m) return 'manual';       // m flag = manual block
  return null;
}

/**
 * Extract block reference ID from Guesty blockRefs array
 */
export function getBlockRef(blockRefs?: GuestyCalendarDay['blockRefs']): string | null {
  return blockRefs && blockRefs.length > 0 ? blockRefs[0]._id : null;
}

/**
 * Map Guesty calendar day to internal availability model
 */
export function mapAvailability(
  guestyDay: GuestyCalendarDay
): Omit<Availability, 'id' | 'created_at' | 'updated_at'> {
  const now = new Date().toISOString();

  return {
    listing_id: guestyDay.listingId,
    date: guestyDay.date,
    status: mapStatus(guestyDay),
    price: guestyDay.price,
    min_nights: guestyDay.minNights,
    closed_to_arrival: guestyDay.cta ?? false,
    closed_to_departure: guestyDay.ctd ?? false,
    block_type: getBlockType(guestyDay.blocks),
    block_ref: getBlockRef(guestyDay.blockRefs),
    last_synced_at: now,
  };
}

/**
 * Convert internal availability to database insert/update object
 */
export function availabilityToDbRow(availability: Omit<Availability, 'id' | 'created_at' | 'updated_at'>) {
  return {
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
  };
}

/**
 * Batch map multiple calendar days
 */
export function mapAvailabilityBatch(
  guestyDays: GuestyCalendarDay[]
): Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> {
  return guestyDays.map(mapAvailability);
}