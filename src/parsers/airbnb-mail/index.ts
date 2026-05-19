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

// "Deine Buchungsänderung wurde bestätigt"
const MODIFICATION_RE = /^Deine\s+Buchungs[äa]nderung\s+wurde\s+best[äa]tigt/i;

// "Anfrage für „{Listing}" für den {Datum}"
const INQUIRY_RE = /^Anfrage\s+für\s+[„"]/i;

// Cancellation: no live samples yet; keep broad fallback. The body parser
// (cancellation.ts) is permissive — needs only the reservation code.
const CANCELLATION_RE = /(storniert|stornierung|abgesagt)/i;

export function detectMailType(subject: string): AirbnbMailType {
  if (!subject) return 'unknown';
  if (CANCELLATION_RE.test(subject)) return 'cancellation';
  if (MODIFICATION_RE.test(subject)) return 'modification';
  if (CONFIRMED_RE.test(subject)) return 'confirmed';
  if (INQUIRY_RE.test(subject)) return 'inquiry';
  return 'unknown';
}
