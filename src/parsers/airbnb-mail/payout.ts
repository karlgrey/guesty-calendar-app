/**
 * Airbnb Payout-Mail Parser
 *
 * "Wir haben eine Auszahlung in Höhe von X € EUR gesendet" — the body lists
 * line items per reservation: amount, category, stay dates, listing id, HM-code.
 * These amounts are the ground truth for what Airbnb actually transferred
 * (net of co-host share and Italian withholding), unlike the booking-mail
 * estimate. Calibrated against live Firenze payout mail (Aug 2026).
 */
import { getBodyText } from './body-text.js';
import type { RawMail } from '../../types/airbnb-mail.js';

export interface ParsedPayoutItem {
  amount: number;
  category: string;
  stayStart: string;
  stayEnd: string;
  listingId: string;
  reservationCode: string;
}

export interface ParsedPayoutMail {
  totalAmount: number;
  payoutDate: string;
  items: ParsedPayoutItem[];
  messageId: string;
}

const SUBJECT_TOTAL_RE = /^Wir haben eine Auszahlung in H[öo]he von\s*([\d.,]+)\s*€/i;

// "-31,50 € EUR Steuereinbehalt bei Einkünften in Italien • 2.8.2026 - 8.8.2026 … (1678837365136764301) HME9WZFQTY"
// Category excludes "€" so the match can't run on past the leading "{total} € EUR wurden … versendet"
// preamble (which contains its own "€"/"(EUR)" tokens) into the first real line item.
// NOTE: gaps after "EUR" and after the end-date use \s* (zero-or-more), not \s+ —
// live Airbnb HTML puts each piece (amount / category+dates / listing name / HM-code)
// in its own sibling tag with NO whitespace text node between them, so cheerio's
// flattened body text reads "...EURUnterkunft" / "8.8.2026Elegance & Design..." with
// zero spaces at exactly those two joints (calibrated against a real backfill run,
// Aug 2026 — the hand-written inline fixture above has spaces there and missed this).
// The code capture is non-greedy with a lookahead boundary (whitespace / the
// start of the next "amount € EUR" run / end-of-string) rather than a fixed
// {8} length — real codes have always been exactly 10 chars ("HM" + 8), but
// nothing guarantees that forever (review finding #2, consistency with
// ical-parser.ts's unbounded DESCRIPTION_CODE_RE). A plain unbounded `+`
// over-consumes into the next item's amount digits when the real Airbnb HTML
// has zero whitespace between adjacent items (see NOTE above) — the lookahead
// keeps that case correct while still allowing longer codes.
const ITEM_RE =
  /(-?[\d.,]+)\s*€\s*EUR\s*([^€]+?)\s*•\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[^()]*\((\d{10,25})\)\s*(HM[A-Z0-9]+?)(?=\s|-?[\d.,]+\s*€\s*EUR|$)/g;

function parseGermanAmount(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

const iso = (y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

export function parsePayoutMail(raw: RawMail): ParsedPayoutMail | null {
  const subjectMatch = raw.subject.match(SUBJECT_TOTAL_RE);
  if (!subjectMatch) return null;

  const body = getBodyText(raw);
  const items: ParsedPayoutItem[] = [];
  for (const m of body.matchAll(ITEM_RE)) {
    items.push({
      amount: parseGermanAmount(m[1]),
      category: m[2].trim(),
      stayStart: iso(m[5], m[4], m[3]),
      stayEnd: iso(m[8], m[7], m[6]),
      listingId: m[9],
      reservationCode: m[10],
    });
  }

  return {
    totalAmount: parseGermanAmount(subjectMatch[1]),
    payoutDate: raw.receivedAt.slice(0, 10),
    items,
    messageId: raw.messageId,
  };
}
