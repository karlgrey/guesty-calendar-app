/**
 * Airbnb-Mail Integration Type Definitions
 *
 * See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
 */

/**
 * Mail as received via IMAP, before parsing.
 */
export interface RawMail {
  uid: number;
  messageId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string; // ISO 8601
  htmlBody: string;
  textBody: string;
}

/**
 * Placeholder date used by parseCancellation (and any other lax parser) when
 * a mail doesn't carry real check-in/check-out dates. Shared between the
 * parser (emits it) and the mapper (must never let it clobber a good date
 * already on file — see #660).
 */
export const AIRBNB_MAIL_PLACEHOLDER_DATE = '1970-01-01';

/**
 * Mail-type classification.
 */
export type AirbnbMailType =
  | 'confirmed'
  | 'inquiry'
  | 'cancellation'
  | 'modification'
  | 'payout'
  | 'unknown';

/**
 * Parsed structured mail data — output of any parser.
 */
export interface ParsedAirbnbMail {
  type: Exclude<AirbnbMailType, 'unknown' | 'payout'>;
  reservationCode: string; // Airbnb HM-code, e.g. "HMABCXYZ"
  guestName: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  numberOfGuests?: number;
  numberOfAdults?: number;
  numberOfChildren?: number;
  totalPrice?: number;
  hostPayout?: number;        // "Du verdienst" from the booking mail — brutto, before co-host + income tax
  cleaningFee?: number;
  serviceFee?: number;        // guest-side Airbnb service fee
  occupancyTax?: number;      // "Belegungssteuern" — Airbnb passes these through, not part of host revenue
  receivedAt: string;
  messageId: string;
}

/**
 * iCal event from Airbnb listing calendar.
 */
export interface AirbnbIcalEvent {
  uid: string; // e.g. "HMABCXYZ@airbnb.com"
  reservationCode: string; // extracted from uid: "HMABCXYZ"
  startDate: string; // YYYY-MM-DD (DTSTART)
  endDate: string; // YYYY-MM-DD (DTEND, exclusive)
  summary: string;
}
