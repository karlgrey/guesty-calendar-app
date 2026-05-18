/**
 * Airbnb Booking-Inquiry Parser
 *
 * Inquiries have less data than confirmed bookings — typically no host payout
 * yet. We extract the core fields (code, guest, dates) and leave financials
 * undefined.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseBookingInquiry(raw: RawMail): ParsedAirbnbMail | null {
  // Reuse the confirmed parser's field extraction — financial fields will
  // just be `undefined` if the inquiry mail doesn't contain them.
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'inquiry' };
}
