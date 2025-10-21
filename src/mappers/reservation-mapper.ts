/**
 * Reservation Data Mapper
 *
 * Transforms Guesty calendar API reservation data to internal Reservation model
 */

import type { GuestyCalendarDay } from '../types/guesty.js';
import type { Reservation } from '../types/models.js';
import logger from '../utils/logger.js';

/**
 * Extract reservation data from calendar day
 */
export function extractReservationFromCalendar(
  day: GuestyCalendarDay,
  lastSyncedAt: string
): Omit<Reservation, 'id' | 'created_at' | 'updated_at'> | null {
  // Find blockRef with reservation data
  const reservationBlock = day.blockRefs?.find(ref => ref.reservation);

  if (!reservationBlock || !reservationBlock.reservation) {
    return null;
  }

  const res = reservationBlock.reservation;

  try {
    return {
      reservation_id: res._id,
      listing_id: res.listingId,

      // Dates
      check_in: res.checkIn,
      check_out: res.checkOut,
      check_in_localized: res.checkInDateLocalized || null,
      check_out_localized: res.checkOutDateLocalized || null,
      nights_count: res.nightsCount || 0,

      // Guest information
      guest_id: res.guestId || null,
      guest_name: res.guest?.fullName || null,
      guests_count: res.guestsCount || null,
      adults_count: res.numberOfGuests?.numberOfAdults || null,
      children_count: res.numberOfGuests?.numberOfChildren || null,
      infants_count: res.numberOfGuests?.numberOfInfants || null,

      // Booking details
      status: res.status,
      confirmation_code: res.confirmationCode || null,
      source: res.source || null,
      platform: res.integration?.platform || null,

      // Times
      planned_arrival: res.plannedArrival || null,
      planned_departure: res.plannedDeparture || null,

      // Financial
      currency: res.money?.currency || null,
      total_price: res.money?.fareAccommodationAdjusted || null,
      host_payout: res.money?.hostPayout || null,
      balance_due: res.money?.balanceDue || null,
      total_paid: res.money?.totalPaid || null,

      // Metadata
      created_at_guesty: res.createdAt || null,
      reserved_at: res.reservedAt || null,
      last_synced_at: lastSyncedAt,
    };
  } catch (error) {
    logger.error({ error, reservationId: res._id }, 'Failed to map reservation from calendar day');
    return null;
  }
}

/**
 * Extract all unique reservations from calendar response
 */
export function extractReservationsFromCalendar(
  calendar: GuestyCalendarDay[],
  lastSyncedAt: string
): Array<Omit<Reservation, 'id' | 'created_at' | 'updated_at'>> {
  const reservationsMap = new Map<string, Omit<Reservation, 'id' | 'created_at' | 'updated_at'>>();

  for (const day of calendar) {
    const reservation = extractReservationFromCalendar(day, lastSyncedAt);
    if (reservation) {
      // Use Map to deduplicate by reservation_id (same reservation spans multiple days)
      reservationsMap.set(reservation.reservation_id, reservation);
    }
  }

  return Array.from(reservationsMap.values());
}
