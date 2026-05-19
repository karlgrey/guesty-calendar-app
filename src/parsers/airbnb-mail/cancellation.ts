/**
 * Airbnb Cancellation Parser
 *
 * Cancellation mails are intentionally lax: we only require the reservation
 * code. Real cancellation mails often omit guest name and dates, but the code
 * is enough to identify which reservation to remove from `reservations`.
 */

import * as cheerio from 'cheerio';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

const RES_CODE_RE = /(?:Reservierungscode|Buchungscode)\s*:?\s*(HM[A-Z0-9]+)/i;
const SUBJECT_CODE_RE = /(HM[A-Z0-9]+)/;
const GUEST_RE = /(?:Gast|Gastname)\s*:?\s*([^\n\r<]+)/i;
const CHECK_IN_RE = /Check-?in\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;
const CHECK_OUT_RE = /Check-?out\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;

const MONATE: Record<string, string> = {
  januar: '01', februar: '02', märz: '03', maerz: '03', april: '04',
  mai: '05', juni: '06', juli: '07', august: '08', september: '09',
  oktober: '10', november: '11', dezember: '12',
};

function parseGermanDate(day: string, month: string, year: string): string | null {
  const mm = MONATE[month.toLowerCase()];
  if (!mm) return null;
  return `${year}-${mm}-${day.padStart(2, '0')}`;
}

function getBodyText(raw: RawMail): string {
  if (raw.textBody && raw.textBody.length > 0) return raw.textBody;
  if (raw.htmlBody) {
    const $ = cheerio.load(raw.htmlBody);
    return $('body').text();
  }
  return '';
}

export function parseCancellation(raw: RawMail): ParsedAirbnbMail | null {
  const body = getBodyText(raw);
  // Try body first, fall back to subject for the reservation code
  const codeMatch = body.match(RES_CODE_RE) ?? raw.subject.match(SUBJECT_CODE_RE);
  if (!codeMatch) return null;

  const guestMatch = body.match(GUEST_RE);
  const checkInMatch = body.match(CHECK_IN_RE);
  const checkOutMatch = body.match(CHECK_OUT_RE);

  const checkIn = checkInMatch
    ? parseGermanDate(checkInMatch[1], checkInMatch[2], checkInMatch[3])
    : null;
  const checkOut = checkOutMatch
    ? parseGermanDate(checkOutMatch[1], checkOutMatch[2], checkOutMatch[3])
    : null;

  // For cancellations we accept missing guest/dates — emit placeholders so the
  // downstream mapper can still write an inquiry-row, and the cancellation
  // DELETE-by-reservation_code path in sync-mail can fire.
  return {
    type: 'cancellation',
    reservationCode: codeMatch[1],
    guestName: guestMatch ? guestMatch[1].trim() : '(unknown — cancellation)',
    checkIn: checkIn ?? '1970-01-01',
    checkOut: checkOut ?? '1970-01-01',
    receivedAt: raw.receivedAt,
    messageId: raw.messageId,
  };
}
