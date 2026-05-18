/**
 * Airbnb Modification Parser
 *
 * Date-change mails. We reuse the confirmed-booking field extractor — if the
 * mail contains snapshot fields (most do), we extract them. Otherwise null.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseModification(raw: RawMail): ParsedAirbnbMail | null {
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'modification' };
}
