/**
 * Airbnb Confirmed-Booking Parser
 *
 * Extracts structured data from a confirmed-booking mail. Uses regex on the
 * text-body as primary, HTML stripping as fallback. Patterns are initial
 * estimates — calibrate after live data lands in airbnb_mail_archive.
 */

import * as cheerio from 'cheerio';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

const RES_CODE_RE = /(?:Reservierungscode|Buchungscode)\s*:?\s*(HM[A-Z0-9]+)/i;
const GUEST_RE = /(?:Gast|Gastname)\s*:?\s*([^\n\r<]+)/i;
const CHECK_IN_RE = /Check-?in\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;
const CHECK_OUT_RE = /Check-?out\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;
const GUESTS_RE = /G[äa]ste\s*:?\s*(\d+)/i;
const CLEANING_RE = /Reinigungsgeb[üu]hr\s*:?\s*([\d.,]+)\s*€/i;
const SERVICE_RE = /Service-?Geb[üu]hr(?:\s+Airbnb)?\s*:?\s*([\d.,]+)\s*€/i;
// Matches patterns like:
//   "du erhältst: 270,00 €"
//   "Auszahlung an dich: 270,00 €"
//   "Gesamt (du erhältst): 270,00 €"
const HOST_PAYOUT_RE =
  /(?:du erh[äa]ltst|Auszahlung an dich|Gesamt[^(\n]*\(du erh[äa]ltst\))\s*:?\s*([\d.,]+)\s*€/i;
const TOTAL_RE = /Gesamt(?:betrag)?(?:\s*\(Gast\))?\s*:?\s*([\d.,]+)\s*€/i;

const MONATE: Record<string, string> = {
  januar: '01',
  februar: '02',
  märz: '03',
  maerz: '03',
  april: '04',
  mai: '05',
  juni: '06',
  juli: '07',
  august: '08',
  september: '09',
  oktober: '10',
  november: '11',
  dezember: '12',
};

function parseGermanDate(day: string, month: string, year: string): string {
  const mm = MONATE[month.toLowerCase()];
  if (!mm) throw new Error(`Unknown German month: ${month}`);
  return `${year}-${mm}-${day.padStart(2, '0')}`;
}

function parseAmount(s: string): number {
  // "270,00" or "1.234,56" → 270 / 1234.56
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function getBodyText(raw: RawMail): string {
  if (raw.textBody && raw.textBody.length > 0) return raw.textBody;
  if (raw.htmlBody) {
    const $ = cheerio.load(raw.htmlBody);
    return $('body').text();
  }
  return '';
}

export function parseConfirmedBooking(raw: RawMail): ParsedAirbnbMail | null {
  const body = getBodyText(raw);
  const codeMatch = body.match(RES_CODE_RE);
  if (!codeMatch) return null;
  const guestMatch = body.match(GUEST_RE);
  const checkInMatch = body.match(CHECK_IN_RE);
  const checkOutMatch = body.match(CHECK_OUT_RE);
  if (!guestMatch || !checkInMatch || !checkOutMatch) return null;

  const guestsMatch = body.match(GUESTS_RE);
  const cleaningMatch = body.match(CLEANING_RE);
  const serviceMatch = body.match(SERVICE_RE);
  const hostPayoutMatch = body.match(HOST_PAYOUT_RE);
  const totalMatch = body.match(TOTAL_RE);

  return {
    type: 'confirmed',
    reservationCode: codeMatch[1],
    guestName: guestMatch[1].trim(),
    checkIn: parseGermanDate(checkInMatch[1], checkInMatch[2], checkInMatch[3]),
    checkOut: parseGermanDate(checkOutMatch[1], checkOutMatch[2], checkOutMatch[3]),
    numberOfGuests: guestsMatch ? parseInt(guestsMatch[1], 10) : undefined,
    cleaningFee: cleaningMatch ? parseAmount(cleaningMatch[1]) : undefined,
    serviceFee: serviceMatch ? parseAmount(serviceMatch[1]) : undefined,
    hostPayout: hostPayoutMatch ? parseAmount(hostPayoutMatch[1]) : undefined,
    totalPrice: totalMatch ? parseAmount(totalMatch[1]) : undefined,
    receivedAt: raw.receivedAt,
    messageId: raw.messageId,
  };
}
