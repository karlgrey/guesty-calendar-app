/**
 * Hostex API Type Definitions
 *
 * Based on live-tested responses from /v3/properties, /v3/reservations,
 * /v3/listings/calendar. Only the fields we actually consume are typed.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

/**
 * Common envelope returned by all Hostex API endpoints
 */
export interface HostexEnvelope<T> {
  request_id: string;
  error_code: number; // 200 = success
  error_msg: string;
  data: T;
}

/**
 * Property — from GET /v3/properties
 */
export interface HostexProperty {
  id: number;
  title: string;
  channels: Array<{
    channel_type: string; // e.g. "airbnb"
    listing_id: string;   // channel-specific listing identifier
    currency: string;
  }>;
  default_checkin_time?: string;  // "15:00"
  default_checkout_time?: string; // "12:00"
  timezone?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  wifi_ssid?: string;
  wifi_password?: string;
  wifi_remarks?: string;
}

/**
 * Reservation rate detail line item
 */
export interface HostexRateDetail {
  type: string; // ACCOMMODATION, CLEANING_FEE, HOST_SERVICE_FEE, ...
  description: string;
  currency: string;
  amount: number;
}

/**
 * Reservation — from GET /v3/reservations
 */
export interface HostexReservation {
  reservation_code: string;
  stay_code: string;
  channel_id: string;
  channel_type: string;
  listing_id: string;
  property_id: number;
  status: 'wait_accept' | 'wait_pay' | 'accepted' | 'cancelled' | 'denied' | 'timeout' | string;
  stay_status?: 'checkin_pending' | 'in_house' | 'stay_completed' | string;
  check_in_date: string;  // "YYYY-MM-DD"
  check_out_date: string; // "YYYY-MM-DD"
  number_of_guests?: number;
  number_of_adults?: number;
  number_of_children?: number;
  number_of_infants?: number;
  number_of_pets?: number;
  guest_name?: string;
  guest_phone?: string;
  guest_email?: string;
  cancelled_at?: string | null;
  booked_at?: string;
  created_at?: string;
  creator?: string;
  rates?: {
    total_rate?: { currency: string; amount: number };
    total_commission?: { currency: string; amount: number };
    rate?: { currency: string; amount: number };
    commission?: { currency: string; amount: number };
    details?: HostexRateDetail[];
  };
  conversation_id?: string;
  remarks?: string;
}

/**
 * Calendar day — from POST /v3/listings/calendar
 */
export interface HostexCalendarDay {
  date: string; // "YYYY-MM-DD"
  price: number;
  inventory: number; // 0 or 1 (0 = blocked/booked, 1 = available)
  restrictions: {
    min_stay_on_arrival: number;
    max_stay_on_arrival: number;
    closed_on_arrival: boolean;
    closed_on_departure: boolean;
  };
}

/**
 * Listing calendar entry (one per requested listing)
 */
export interface HostexListingCalendar {
  listing_id: string;
  channel_type: string;
  calendar: HostexCalendarDay[];
}

export interface HostexCalendarResponse {
  listings: HostexListingCalendar[];
}

/**
 * Wrapper for query responses
 */
export interface HostexPropertiesData { properties: HostexProperty[] }
export interface HostexReservationsData { reservations: HostexReservation[] }
