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

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'ae', Ö: 'oe', Ü: 'ue',
};

function normalizeUnicode(input: string): string {
  let out = input;
  for (const [from, to] of Object.entries(UMLAUT_MAP)) {
    out = out.replaceAll(from, to);
  }
  // Strip remaining combining diacritics (é → e, ñ → n, etc.).
  // Unicode range ̀-ͯ covers "Combining Diacritical Marks".
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return out.toLowerCase();
}

function personMode(normalized: string): GuestFingerprint {
  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { id: null, company: null };
  return { id: tokens.join('_'), company: null };
}

export function fingerprintGuest(
  rawName: string | null | undefined
): GuestFingerprint {
  if (rawName == null) return { id: null, company: null };
  const trimmed = rawName.trim();
  if (trimmed === '') return { id: null, company: null };

  try {
    const normalized = normalizeUnicode(trimmed).replace(/\s+/g, ' ').trim();
    // Firma-Detektion kommt im nächsten Task. Vorerst nur Person-Mode.
    return personMode(normalized);
  } catch {
    return { id: null, company: null };
  }
}
