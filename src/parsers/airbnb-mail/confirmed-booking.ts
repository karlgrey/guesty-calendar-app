/**
 * Airbnb Confirmed-Booking Parser
 *
 * Extracts structured data from a confirmed-booking mail. Subject carries the
 * full guest name; body carries reservation code, dates (without year), guests,
 * and prices. Year is inferred from the mail's receivedAt timestamp.
 *
 * Patterns calibrated against live German Airbnb host mail (May 2026).
 */

import * as cheerio from 'cheerio';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

// Subject: "Buchung bestätigt – {Guest Full Name} kommt am {D}. {Month} an"
const SUBJECT_RE = /^Buchung\s+best[äa]tigt\s*[–-]\s+(.+?)\s+kommt\s+am\s+(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ.]+?)\s+an/i;

// Body: "Bestätigungs-Code HMABCXYZ". Whitespace-collapsed text may concat the
// next button text ("…CJHReiseplan ansehen"), so we anchor on the known length:
// Airbnb host codes are "HM" + 8 alphanumerics = 10 chars.
const RES_CODE_RE = /Best[äa]tigungs[-\s]?Code\s*(HM[A-Z0-9]{8})/i;

// Body (post-whitespace-collapse): "Check-inSo., 17. Mai 15:00" → date without year.
const CHECK_IN_RE = /Check-?in\s*[A-Za-zäöüÄÖÜ]{2,4}\.\,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ.]+?)\s*\d{1,2}:\d{2}/i;
const CHECK_OUT_RE = /Check-?out\s*[A-Za-zäöüÄÖÜ]{2,4}\.\,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ.]+?)\s*\d{1,2}:\d{2}/i;

// "Gäste 1 Erwachsene:r" / "Gäste 2 Erwachsene"
const GUESTS_RE = /G[äa]ste\s*(\d+)\s*Erwachsene/i;
const CLEANING_RE = /Reinigungsgeb[üu]hr\s*([\d.,]+)\s*€/i;
// Guest-side service fee — usually 0 € for hosts charged via Airbnb's split.
const SERVICE_RE = /Servicegeb[üa]hr\s+für\s+G[äa]ste\s*([\d.,]+)\s*€/i;
// "Belegungssteuern 30,00 €" — Airbnb passes through to the host but is not host revenue.
const OCCUPANCY_TAX_RE = /Belegungssteuern\s*([\d.,]+)\s*€/i;
// "Du verdienst 1.043,90 €" — host payout net of Airbnb's host fee.
const HOST_PAYOUT_RE = /Du\s+verdienst\s*([\d.,]+)\s*€/i;
// "Gesamt (EUR) 1.310,00 €"
const TOTAL_RE = /Gesamt\s*\(EUR\)\s*([\d.,]+)\s*€/i;

const MONATE: Record<string, string> = {
  januar: '01', 'jan.': '01',
  februar: '02', 'feb.': '02',
  märz: '03', maerz: '03',
  april: '04', 'apr.': '04',
  mai: '05',
  juni: '06',
  juli: '07',
  august: '08', 'aug.': '08',
  september: '09', 'sept.': '09', 'sep.': '09',
  oktober: '10', 'okt.': '10',
  november: '11', 'nov.': '11',
  dezember: '12', 'dez.': '12',
};

function monthToNumber(monthRaw: string): string | null {
  return MONATE[monthRaw.toLowerCase().trim()] ?? null;
}

function inferYear(monthNum: string, day: number, receivedAtIso: string): number {
  const received = new Date(receivedAtIso);
  const recYear = received.getUTCFullYear();
  const recMonth = received.getUTCMonth() + 1; // 1-12
  const recDay = received.getUTCDate();
  const m = parseInt(monthNum, 10);
  // If the (month, day) is before today's (month, day), it must mean next year.
  if (m < recMonth || (m === recMonth && day < recDay)) return recYear + 1;
  return recYear;
}

function buildDate(day: number, monthNum: string, year: number): string {
  return `${year}-${monthNum}-${String(day).padStart(2, '0')}`;
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function getBodyText(raw: RawMail): string {
  if (raw.htmlBody && raw.htmlBody.length > 0) {
    const $ = cheerio.load(raw.htmlBody);
    $('style,script').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }
  if (raw.textBody) return raw.textBody.replace(/\s+/g, ' ').trim();
  return '';
}

export function parseConfirmedBooking(raw: RawMail): ParsedAirbnbMail | null {
  const subjectMatch = raw.subject.match(SUBJECT_RE);
  if (!subjectMatch) return null;
  const guestName = subjectMatch[1].trim();

  const body = getBodyText(raw);
  const codeMatch = body.match(RES_CODE_RE);
  if (!codeMatch) return null;
  const reservationCode = codeMatch[1];

  const inMatch = body.match(CHECK_IN_RE);
  const outMatch = body.match(CHECK_OUT_RE);
  if (!inMatch || !outMatch) return null;

  const inMonth = monthToNumber(inMatch[2]);
  const outMonth = monthToNumber(outMatch[2]);
  if (!inMonth || !outMonth) return null;

  const inDay = parseInt(inMatch[1], 10);
  const outDay = parseInt(outMatch[1], 10);

  const inYear = inferYear(inMonth, inDay, raw.receivedAt);
  // Check-out year: if month wraps backwards relative to check-in, year + 1.
  const outYear =
    parseInt(outMonth, 10) < parseInt(inMonth, 10) ? inYear + 1 : inYear;

  const guestsMatch = body.match(GUESTS_RE);
  const cleaningMatch = body.match(CLEANING_RE);
  const serviceMatch = body.match(SERVICE_RE);
  const occupancyTaxMatch = body.match(OCCUPANCY_TAX_RE);
  const hostPayoutMatch = body.match(HOST_PAYOUT_RE);
  const totalMatch = body.match(TOTAL_RE);

  return {
    type: 'confirmed',
    reservationCode,
    guestName,
    checkIn: buildDate(inDay, inMonth, inYear),
    checkOut: buildDate(outDay, outMonth, outYear),
    numberOfGuests: guestsMatch ? parseInt(guestsMatch[1], 10) : undefined,
    cleaningFee: cleaningMatch ? parseAmount(cleaningMatch[1]) : undefined,
    serviceFee: serviceMatch ? parseAmount(serviceMatch[1]) : undefined,
    occupancyTax: occupancyTaxMatch ? parseAmount(occupancyTaxMatch[1]) : undefined,
    hostPayout: hostPayoutMatch ? parseAmount(hostPayoutMatch[1]) : undefined,
    totalPrice: totalMatch ? parseAmount(totalMatch[1]) : undefined,
    receivedAt: raw.receivedAt,
    messageId: raw.messageId,
  };
}
