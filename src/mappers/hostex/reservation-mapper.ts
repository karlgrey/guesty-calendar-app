/**
 * Hostex Reservation Mapper
 *
 * Maps a Hostex reservation to the internal data model. Returns BOTH an
 * inquiry-row (always written, for BI history) and optionally a
 * reservation-row (only for active bookings, blocks calendar).
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import { fingerprintGuest } from '../../utils/guest-fingerprint.js';
import logger from '../../utils/logger.js';
import type { HostexReservation } from '../../types/hostex.js';
import type { Reservation } from '../../types/models.js';

export interface MappedInquiry {
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

export interface MappedReservationResult {
  asInquiry: MappedInquiry;
  asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> | null;
}

const STATUS_TO_INQUIRY: Record<string, string> = {
  accepted: 'confirmed',
  wait_pay: 'reserved',
  wait_accept: 'inquiry',
  cancelled: 'canceled',
  denied: 'declined',
  timeout: 'expired',
};

const ACTIVE_HOSTEX_STATUSES = new Set(['accepted', 'wait_pay']);

function fingerprintSafe(name: string | null) {
  try {
    const fp = fingerprintGuest(name);
    return { internal_guest_id: fp.id, guest_company: fp.company };
  } catch (error) {
    logger.warn({ error, name }, 'fingerprintGuest threw, falling back to nulls');
    return { internal_guest_id: null, guest_company: null };
  }
}

export function mapHostexReservation(
  res: HostexReservation,
  defaultTimes: { checkIn: string; checkOut: string }
): MappedReservationResult {
  const now = new Date().toISOString();
  const listingId = String(res.property_id);
  const guestName = res.guest_name ?? null;
  const fp = fingerprintSafe(guestName);

  // Status routing
  let inquiryStatus = STATUS_TO_INQUIRY[res.status];
  let reservationStatus: string | null = null;
  if (!inquiryStatus) {
    inquiryStatus = 'inquiry';
    reservationStatus = 'reserved'; // defensive — block calendar
    logger.warn(
      { reservation_code: res.reservation_code, hostex_status: res.status },
      'Unknown Hostex status, mapping defensively'
    );
  } else if (ACTIVE_HOSTEX_STATUSES.has(res.status)) {
    reservationStatus = res.status === 'accepted' ? 'confirmed' : 'reserved';
  }

  // Compose ISO check-in/out by combining DATE with default time.
  const checkInIso = `${res.check_in_date}T${defaultTimes.checkIn}:00.000Z`;
  const checkOutIso = `${res.check_out_date}T${defaultTimes.checkOut}:00.000Z`;

  // Nights count from dates
  const nights = Math.round(
    (Date.parse(`${res.check_out_date}T00:00:00Z`) - Date.parse(`${res.check_in_date}T00:00:00Z`)) /
      (1000 * 60 * 60 * 24)
  );

  // Financials
  const totalPrice = res.rates?.total_rate?.amount ?? 0;
  const totalCommission = res.rates?.total_commission?.amount ?? 0;
  const hostPayout = totalPrice - totalCommission;

  const asInquiry: MappedInquiry = {
    inquiry_id: res.reservation_code,
    listing_id: listingId,
    status: inquiryStatus,
    check_in: res.check_in_date,
    check_out: res.check_out_date,
    guest_name: guestName,
    guests_count: res.number_of_guests ?? null,
    source: res.channel_type ?? null,
    created_at_guesty: res.created_at ?? res.booked_at ?? null,
    last_synced_at: now,
  };

  if (!reservationStatus) {
    return { asInquiry, asReservation: null };
  }

  const asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> = {
    reservation_id: res.reservation_code,
    listing_id: listingId,
    check_in: checkInIso,
    check_out: checkOutIso,
    check_in_localized: res.check_in_date,
    check_out_localized: res.check_out_date,
    nights_count: nights,
    guest_id: null,
    guest_name: guestName,
    guests_count: res.number_of_guests ?? null,
    adults_count: res.number_of_adults ?? null,
    children_count: res.number_of_children ?? null,
    infants_count: res.number_of_infants ?? null,
    status: reservationStatus,
    confirmation_code: res.channel_id ?? null,
    source: res.channel_type ?? null,
    platform: res.channel_type ?? null,
    planned_arrival: null,
    planned_departure: null,
    currency: res.rates?.total_rate?.currency ?? null,
    total_price: totalPrice,
    host_payout: hostPayout,
    balance_due: null,
    total_paid: null,
    created_at_guesty: res.created_at ?? res.booked_at ?? null,
    reserved_at: res.booked_at ?? null,
    last_synced_at: now,
    internal_guest_id: fp.internal_guest_id,
    guest_company: fp.guest_company,
  };

  return { asInquiry, asReservation };
}
