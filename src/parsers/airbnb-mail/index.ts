/**
 * Airbnb Mail Type Dispatcher
 *
 * Classifies an Airbnb mail by Subject pattern. Patterns calibrated against
 * live Airbnb host mail (Firenze property, May 2026). The mailbox contains a
 * mix of booking mails, message threads, 2FA codes, payouts, etc.; only the
 * four canonical Subjects below are actionable for ETL.
 */

import type { AirbnbMailType } from '../../types/airbnb-mail.js';

// "Buchung bestätigt – {Name} kommt am {Datum} an"
// Dash may be en-dash (–) or hyphen (-).
const CONFIRMED_RE = /^Buchung\s+best[äa]tigt\s*[–-]\s+.+\s+kommt\s+am\s+/i;

// "Wir haben eine Auszahlung in Höhe von 425,40 € EUR gesendet"
const PAYOUT_RE = /^Wir haben eine Auszahlung in H[öo]he von\s*[\d.,]+\s*€/i;

// "Deine Buchungsänderung wurde bestätigt" | "Buchung aktualisiert" |
// "{Gast} möchte die Buchung ändern" — all alteration-related notifications.
const MODIFICATION_RE =
  /^Deine\s+Buchungs[äa]nderung\s+wurde\s+best[äa]tigt|^Buchung\s+aktualisiert|m[öo]chte\s+die\s+Buchung\s+[äa]ndern/i;

// "Anfrage für „{Listing}" für den {Datum}"
const INQUIRY_RE = /^Anfrage\s+für\s+[„"]/i;

// Cancellation: no live samples yet; keep broad fallback. The body parser
// (cancellation.ts) is permissive — needs only the reservation code.
const CANCELLATION_RE = /(storniert|stornierung|abgesagt)/i;

export function detectMailType(subject: string): AirbnbMailType {
  if (!subject) return 'unknown';
  if (PAYOUT_RE.test(subject)) return 'payout';
  if (CANCELLATION_RE.test(subject)) return 'cancellation';
  if (MODIFICATION_RE.test(subject)) return 'modification';
  if (CONFIRMED_RE.test(subject)) return 'confirmed';
  if (INQUIRY_RE.test(subject)) return 'inquiry';
  return 'unknown';
}
