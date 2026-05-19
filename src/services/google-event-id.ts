import { createHash } from 'node:crypto';

/**
 * Convert a reservation_id to a valid Google Calendar event ID.
 *
 * Google requires base32hex: only `a-v` + `0-9`, length 5-1024. Mongo ObjectIds
 * (Guesty) are pure hex and pass through unchanged after lowercasing/stripping.
 * Hostex (`0-HM...-id...`) and Airbnb (`HMABCXYZ`) often contain `w/x/y/z`,
 * which are NOT in base32hex — those get hashed to a stable SHA-1 hex digest
 * (40 chars, also pure base32hex-safe).
 */
export function toGoogleEventId(reservationId: string): string {
  const stripped = reservationId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stripped.length >= 5 && /^[a-v0-9]+$/.test(stripped)) return stripped;
  return createHash('sha1').update(reservationId).digest('hex');
}
