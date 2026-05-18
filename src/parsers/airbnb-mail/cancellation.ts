/**
 * Airbnb Cancellation Parser
 *
 * Cancellation mails primarily contain the reservation code. Guest/date fields
 * may be included for context; we extract what's there.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseCancellation(raw: RawMail): ParsedAirbnbMail | null {
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'cancellation' };
}
