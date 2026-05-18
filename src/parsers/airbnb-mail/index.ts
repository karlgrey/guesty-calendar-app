/**
 * Airbnb Mail Type Dispatcher
 *
 * Classifies an Airbnb mail by Subject pattern.
 *
 * IMPORTANT: Patterns are initial estimates. They must be calibrated against
 * real anonymised mails after the integration goes live. See spec Section 4.2.
 */

import type { AirbnbMailType } from '../../types/airbnb-mail.js';

const CONFIRMED_RE = /(reservierung best[äa]tigt|buchung best[äa]tigt|✓\s*reserviert)/i;
const INQUIRY_RE = /(anfrage von|buchungsanfrage|m[öo]chte buchen)/i;
const CANCELLATION_RE = /(storniert|stornierung|abgesagt)/i;
const MODIFICATION_RE = /(datum ge[äa]ndert|änderung|aktualisiert)/i;

export function detectMailType(subject: string): AirbnbMailType {
  if (!subject) return 'unknown';
  // Order matters: cancellation/modification patterns may overlap with
  // "Reservierung …" prefix in confirmed.
  if (CANCELLATION_RE.test(subject)) return 'cancellation';
  if (MODIFICATION_RE.test(subject)) return 'modification';
  if (CONFIRMED_RE.test(subject)) return 'confirmed';
  if (INQUIRY_RE.test(subject)) return 'inquiry';
  return 'unknown';
}
