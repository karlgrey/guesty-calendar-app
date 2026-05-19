/**
 * Airbnb Booking-Inquiry Parser
 *
 * Inquiry mails do NOT contain a reservation code (the booking does not exist
 * yet). We extract guest name + dates from the body and synthesize a stable
 * inquiry-id from the messageId.
 *
 * Subject example: "Anfrage für „Listing Name" für den 23.–25. Mai 2026"
 * Body example  : "Antworte auf die Anfrage von M.C … Check-inSa., 23. Mai 15:00 …"
 */

import * as cheerio from 'cheerio';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

// Capture the guest name between "Anfrage von " and the next anchor word.
// Live data has no separator before "Identität" (e.g. "M.CM.CIdentität verifiziert"),
// so we don't require whitespace.
const GUEST_RE = /Antworte\s+auf\s+die\s+Anfrage\s+von\s+(.+?)(?:Identit[äa]t|wurde\s+verifiziert|m[öo]chte\s+buchen)/i;

// Airbnb often renders the guest name twice (link wrapper around plain text),
// producing "M.C M.C" or "M.CM.C". Dedupe by mirror-half check.
function normalizeInquiryGuestName(captured: string): string {
  const t = captured.trim();
  // Odd length with a space at the centre → "X X"
  if (t.length % 2 === 1 && t[(t.length - 1) / 2] === ' ') {
    const half = (t.length - 1) / 2;
    const left = t.slice(0, half);
    const right = t.slice(half + 1);
    if (left === right) return left;
  }
  // Even length, no separator → "XX" concat
  if (t.length % 2 === 0 && t.length > 0) {
    const half = t.length / 2;
    if (t.slice(0, half) === t.slice(half)) return t.slice(0, half);
  }
  return t;
}
const CHECK_IN_RE = /Check-?in\s*[A-Za-zäöüÄÖÜ]{2,4}\.\,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ.]+?)\s*\d{1,2}:\d{2}/i;
const CHECK_OUT_RE = /Check-?out\s*[A-Za-zäöüÄÖÜ]{2,4}\.\,?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ.]+?)\s*\d{1,2}:\d{2}/i;
const GUESTS_RE = /G[äa]ste\s*(\d+)\s*Erwachsene/i;

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

function inferYear(monthNum: string, day: number, receivedAtIso: string): number {
  const received = new Date(receivedAtIso);
  const recYear = received.getUTCFullYear();
  const recMonth = received.getUTCMonth() + 1;
  const recDay = received.getUTCDate();
  const m = parseInt(monthNum, 10);
  if (m < recMonth || (m === recMonth && day < recDay)) return recYear + 1;
  return recYear;
}

function buildDate(day: number, monthNum: string, year: number): string {
  return `${year}-${monthNum}-${String(day).padStart(2, '0')}`;
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

function syntheticInquiryCode(messageId: string): string {
  // Airbnb messageId like "<RR3OhuynR5agGL6EMnZNGg@geopod-ismtpd-12>" → "AIRBNB_INQ_RR3Ohuyn"
  const stripped = messageId.replace(/^<|>$/g, '').split('@')[0];
  return `AIRBNB_INQ_${stripped.slice(0, 16)}`;
}

export function parseBookingInquiry(raw: RawMail): ParsedAirbnbMail | null {
  const body = getBodyText(raw);

  const guestMatch = body.match(GUEST_RE);
  const inMatch = body.match(CHECK_IN_RE);
  const outMatch = body.match(CHECK_OUT_RE);
  if (!guestMatch || !inMatch || !outMatch) return null;

  const inMonth = MONATE[inMatch[2].toLowerCase().trim()];
  const outMonth = MONATE[outMatch[2].toLowerCase().trim()];
  if (!inMonth || !outMonth) return null;

  const inDay = parseInt(inMatch[1], 10);
  const outDay = parseInt(outMatch[1], 10);
  const inYear = inferYear(inMonth, inDay, raw.receivedAt);
  const outYear =
    parseInt(outMonth, 10) < parseInt(inMonth, 10) ? inYear + 1 : inYear;

  const guestsMatch = body.match(GUESTS_RE);

  return {
    type: 'inquiry',
    reservationCode: syntheticInquiryCode(raw.messageId),
    guestName: normalizeInquiryGuestName(guestMatch[1]),
    checkIn: buildDate(inDay, inMonth, inYear),
    checkOut: buildDate(outDay, outMonth, outYear),
    numberOfGuests: guestsMatch ? parseInt(guestsMatch[1], 10) : undefined,
    receivedAt: raw.receivedAt,
    messageId: raw.messageId,
  };
}
