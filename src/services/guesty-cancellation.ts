/**
 * Stornogründe für Guesty PUT /reservations-v3/:id/status mit status 'canceled'
 * (#776). Guesty akzeptiert nur Werte aus dieser festen Liste — sonst
 * 400 VALIDATION_ERROR „Cancellation reason is not valid“. Quelle: allowedValues
 * aus genau diesem 400 (Live-Storno 30.09.2026); Guesty dokumentiert die Liste nicht.
 */
export const GUESTY_CANCELLATION_REASONS = [
  'No Reason Provided',
  'Cancelled Due to Hold/Expiration',
  'Not Comfortable For Owner',
  'Not a Good Fit For Guest',
  'Personal Circumstances',
  'Guest Convenience',
  'Policy Compliance',
  'OTA Policy',
  'Property Issues',
  'Security & Legal Concerns',
  'Management/Ownership Changes',
  'Financial Issues',
  'External Factors',
  'Communication/Technical Issues',
  'Others',
] as const;

export type GuestyCancellationReason = (typeof GUESTY_CANCELLATION_REASONS)[number];

export function isGuestyCancellationReason(value: string): value is GuestyCancellationReason {
  return (GUESTY_CANCELLATION_REASONS as readonly string[]).includes(value);
}

/** Default für bestätigte Direktbuchungen: der Gast sagt ab. */
export const DEFAULT_CANCELLATION_REASON: GuestyCancellationReason = 'Guest Convenience';
