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

// Echte Rechtsformen (juristische Suffixe). Sortierung in findLastLegalForm()
// nach Länge desc, damit "gmbh & co kg" vor "gmbh" gematcht wird.
const LEGAL_FORMS = [
  'gmbh & co kg',
  'gmbh & co. kg',
  'gmbh und co kg',
  'gmbh',
  'mbh',
  'ag',
  'se',
  'ug',
  'kg',
  'ohg',
  'kgaa',
  'ltd',
  'limited',
  'inc',
  'llc',
  'co',
];

// Beschreibungs- und Füllwörter, die NICHT Teil des Markennamens sind.
const STOPWORDS = new Set([
  'für', 'fuer', 'der', 'die', 'das', 'mit', 'und',
  'agency', 'group', 'gruppe', 'holding', 'consulting',
  'advisor', 'markt', 'random', 'house', 'project',
  'beratungs', 'immobilien', 'verlagsgruppe', 'digitale',
  'transformation', 'gesellschaft',
]);

const DOMAIN_SUFFIX = /\.(de|com|net|org|io|eu|ai|app|co)$/i;

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'ae', Ö: 'oe', Ü: 'ue',
};

function normalizeUnicode(input: string): string {
  let out = input;
  for (const [from, to] of Object.entries(UMLAUT_MAP)) {
    out = out.replaceAll(from, to);
  }
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return out.toLowerCase();
}

interface LegalMatch {
  startIndex: number;
  endIndex: number;
}

/**
 * Findet das LETZTE Vorkommen einer Rechtsform im normalisierten String.
 * Längere Treffer (z.B. "gmbh & co kg") gewinnen über kürzere am selben Anfangs-Index,
 * weil die Liste nach Länge absteigend sortiert wird und ein späteres Match einer
 * längeren Form das frühere überschreibt.
 *
 * Das Pattern (?:^|[^a-z0-9])(<form>)(?:[^a-z0-9]|$) matched die Rechtsform mit
 * Wortgrenzen (auch bei Bindestrich davor, z.B. "Beratungs-GmbH").
 */
function findLastLegalForm(normalized: string): LegalMatch | null {
  const sorted = [...LEGAL_FORMS].sort((a, b) => b.length - a.length);
  let best: LegalMatch | null = null;

  for (const form of sorted) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `(?:^|[^a-z0-9])(${escaped})(?:[^a-z0-9]|$)`;
    const re = new RegExp(pattern, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      const startIndex = normalized.indexOf(m[1], m.index);
      const endIndex = startIndex + m[1].length;
      if (!best || startIndex > best.startIndex) {
        best = { startIndex, endIndex };
      }
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return best;
}

function firmaMode(
  rawTrimmed: string,
  normalized: string,
  legal: LegalMatch
): GuestFingerprint {
  // Tokens vor der Rechtsform → Marken-Slug
  const beforeLegal = normalized.substring(0, legal.startIndex).trim();
  const tokens = beforeLegal.split(/\s+/).filter((t) => t.length > 0);

  const cleaned: string[] = [];
  for (const token of tokens) {
    const noDomain = token.replace(DOMAIN_SUFFIX, '');
    const slug = noDomain.replace(/[^a-z0-9]/g, '');
    if (!slug) continue;
    if (STOPWORDS.has(slug)) continue;
    cleaned.push(slug);
  }
  const id = cleaned.length > 0 ? cleaned[0] : null;

  // company = original-Casing-String bis Ende der Rechtsform.
  // Wir suchen die gleiche lowercase-Form der Rechtsform im lower-cased Raw-Input
  // (Rechtsformen enthalten keine Umlaute, also ist die Länge identisch).
  const lowerRaw = rawTrimmed.toLowerCase();
  const legalTokenLower = normalized.substring(legal.startIndex, legal.endIndex);

  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const found = lowerRaw.indexOf(legalTokenLower, searchFrom);
    if (found === -1) break;
    const before = found === 0 ? '' : lowerRaw[found - 1];
    const after =
      found + legalTokenLower.length >= lowerRaw.length
        ? ''
        : lowerRaw[found + legalTokenLower.length];
    const isWordChar = (c: string) => /[a-z0-9]/.test(c);
    if (!isWordChar(before) && !isWordChar(after)) {
      lastIdx = found;
    }
    searchFrom = found + 1;
  }

  const company =
    lastIdx === -1
      ? rawTrimmed.substring(0, legal.endIndex).trim()
      : rawTrimmed.substring(0, lastIdx + legalTokenLower.length).trim();

  return { id, company };
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
    const legal = findLastLegalForm(normalized);
    if (legal) {
      return firmaMode(trimmed, normalized, legal);
    }
    return personMode(normalized);
  } catch {
    return { id: null, company: null };
  }
}
