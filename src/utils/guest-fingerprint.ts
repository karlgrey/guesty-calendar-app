/**
 * Guest Fingerprint
 *
 * Pure function that derives a stable identifier slug and a readable company
 * name from a free-form Guesty guest_name string. Used for repeat-customer
 * analysis without additional API calls.
 *
 * See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md
 */

export interface GuestFingerprint {
  id: string | null;
  company: string | null;
}

export function fingerprintGuest(
  rawName: string | null | undefined
): GuestFingerprint {
  if (rawName == null) return { id: null, company: null };
  const trimmed = rawName.trim();
  if (trimmed === '') return { id: null, company: null };

  // Person-/Firma-Logik kommt in den nächsten Tasks.
  // Vorerst nur Null-/Empty-Handling.
  return { id: null, company: null };
}
