/**
 * Airbnb Reservation Mapper
 *
 * Maps a ParsedAirbnbMail to internal Reservation + Inquiry rows.
 *
 * Status routing:
 *   confirmed / modification → inquiry='confirmed', reservation='confirmed'
 *   inquiry                  → inquiry='inquiry', no reservation row
 *   cancellation             → inquiry='canceled', no reservation row
 */

import { fingerprintGuest } from '../../utils/guest-fingerprint.js';
import logger from '../../utils/logger.js';
import type { ParsedAirbnbMail } from '../../types/airbnb-mail.js';
import type { Reservation } from '../../types/models.js';

export interface MappedAirbnbInquiry {
  inquiry_id: string;
  listing_id: string;
  status: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guests_count: number | null;
  source: string | null;
  created_at_guesty: string | null;
  last_synced_at: string;
}

export interface MappedAirbnbResult {
  asInquiry: MappedAirbnbInquiry;
  asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> | null;
}

const STATUS_MAP_INQUIRY: Record<ParsedAirbnbMail['type'], string> = {
  confirmed: 'confirmed',
  inquiry: 'inquiry',
  cancellation: 'canceled',
  modification: 'confirmed',
};

const ACTIVE_TYPES = new Set<ParsedAirbnbMail['type']>(['confirmed', 'modification']);

function fingerprintSafe(name: string | null) {
  try {
    const fp = fingerprintGuest(name);
    return { internal_guest_id: fp.id, guest_company: fp.company };
  } catch (error) {
    logger.warn({ error, name }, 'fingerprintGuest threw, falling back to nulls');
    return { internal_guest_id: null, guest_company: null };
  }
}

export function mapAirbnbReservation(
  parsed: ParsedAirbnbMail,
  airbnbListingId: string,
  defaultTimes: { checkIn: string; checkOut: string }
): MappedAirbnbResult {
  const now = new Date().toISOString();
  const inquiryStatus = STATUS_MAP_INQUIRY[parsed.type];
  const reservationStatus = ACTIVE_TYPES.has(parsed.type) ? 'confirmed' : null;
  const fp = fingerprintSafe(parsed.guestName);

  const checkInIso = `${parsed.checkIn}T${defaultTimes.checkIn}:00.000Z`;
  const checkOutIso = `${parsed.checkOut}T${defaultTimes.checkOut}:00.000Z`;
  const nights = Math.round(
    (Date.parse(`${parsed.checkOut}T00:00:00Z`) - Date.parse(`${parsed.checkIn}T00:00:00Z`)) /
      (1000 * 60 * 60 * 24)
  );

  const asInquiry: MappedAirbnbInquiry = {
    inquiry_id: parsed.reservationCode,
    listing_id: airbnbListingId,
    status: inquiryStatus,
    check_in: parsed.checkIn,
    check_out: parsed.checkOut,
    guest_name: parsed.guestName,
    guests_count: parsed.numberOfGuests ?? null,
    source: 'airbnb',
    created_at_guesty: parsed.receivedAt,
    last_synced_at: now,
  };

  if (!reservationStatus) {
    return { asInquiry, asReservation: null };
  }

  const asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> = {
    reservation_id: parsed.reservationCode,
    listing_id: airbnbListingId,
    check_in: checkInIso,
    check_out: checkOutIso,
    check_in_localized: parsed.checkIn,
    check_out_localized: parsed.checkOut,
    nights_count: nights,
    guest_id: null,
    guest_name: parsed.guestName,
    guests_count: parsed.numberOfGuests ?? null,
    adults_count: parsed.numberOfAdults ?? null,
    children_count: parsed.numberOfChildren ?? null,
    infants_count: null,
    status: reservationStatus,
    confirmation_code: parsed.reservationCode,
    source: 'airbnb',
    platform: 'airbnb-mail',
    planned_arrival: null,
    planned_departure: null,
    currency: 'EUR',
    total_price: parsed.totalPrice ?? 0,
    host_payout: parsed.hostPayout ?? 0,
    balance_due: null,
    total_paid: null,
    created_at_guesty: parsed.receivedAt,
    reserved_at: parsed.receivedAt,
    last_synced_at: now,
    internal_guest_id: fp.internal_guest_id,
    guest_company: fp.guest_company,
  };

  return { asInquiry, asReservation };
}
