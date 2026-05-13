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
      // Position der Capture-Group 1 = tatsächliche Position der Rechtsform.
      const startIndex = normalized.indexOf(m[1], m.index);
      const endIndex = startIndex + m[1].length;
      if (!best || startIndex > best.startIndex) {
        best = { startIndex, endIndex };
      }
      // Endlos-Loop-Schutz bei Zero-Width-Matches.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return best;
}

/**
 * Canonical legal-form casing (keyed by lowercase).
 */
const CANONICAL_LEGAL_CASE: Record<string, string> = {
  'gmbh & co kg': 'GmbH & Co KG',
  'gmbh & co. kg': 'GmbH & Co. KG',
  'gmbh und co kg': 'GmbH und Co KG',
  'gmbh': 'GmbH',
  'mbh': 'mbH',
  'ag': 'AG',
  'se': 'SE',
  'ug': 'UG',
  'kg': 'KG',
  'ohg': 'OHG',
  'kgaa': 'KGaA',
  'ltd': 'Ltd',
  'limited': 'Limited',
  'inc': 'Inc',
  'llc': 'LLC',
  'co': 'Co',
};

/**
 * Normalise company casing so that results are case-invariant with respect to
 * the raw input, while still preserving intentional mixed-case in the input.
 *
 * Strategy (per space-separated word):
 *   - If the word's lowercase matches a legal-form → replace with canonical form.
 *   - Else if the word is ALL-UPPERCASE → convert to Title-Case (e.g. "REWE" → "Rewe").
 *   - Otherwise → keep as-is (preserves "digitransform.de", "für", "Gesellschaft", etc.).
 *
 * This satisfies two constraints simultaneously:
 *   1. `fingerprintGuest('REWE MARKT GMBH').company === fingerprintGuest('Rewe Markt GmbH').company`
 *   2. The company for an already mixed-case input like
 *      `'digitransform.de Gesellschaft für digitale Transformation mbH'`
 *      is returned verbatim.
 */
function normalizeCompanyCasing(input: string): string {
  const lower = input.toLowerCase();

  // Locate the last legal-form span (substring, with word-boundary check).
  const sortedForms = Object.keys(CANONICAL_LEGAL_CASE).sort((a, b) => b.length - a.length);
  let legalStart = -1;
  let legalEnd = -1;
  let canonicalForm = '';

  for (const form of sortedForms) {
    let searchFrom = 0;
    let lastFound = -1;
    while (true) {
      const found = lower.indexOf(form, searchFrom);
      if (found === -1) break;
      const before = found === 0 ? '' : lower[found - 1];
      const after = found + form.length >= lower.length ? '' : lower[found + form.length];
      const isWordChar = (c: string) => /[a-z0-9]/.test(c);
      if (!isWordChar(before) && !isWordChar(after)) {
        lastFound = found;
      }
      searchFrom = found + 1;
    }
    if (lastFound !== -1 && lastFound > legalStart) {
      legalStart = lastFound;
      legalEnd = lastFound + form.length;
      canonicalForm = CANONICAL_LEGAL_CASE[form];
    }
  }

  /**
   * Normalise a single non-legal-form word:
   * ALL-CAPS → title-case; anything else → keep as-is.
   */
  function normalizeWord(word: string): string {
    if (word === word.toUpperCase() && /[A-Z]/.test(word)) {
      // All uppercase (at least one letter) → title-case.
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word;
  }

  if (legalStart === -1) {
    // No legal form – normalize each word.
    return input
      .split(/(\s+)/)
      .map((part) => (part.trim() ? normalizeWord(part) : part))
      .join('');
  }

  // Split into: before-legal, legal-form token, after-legal.
  const beforeStr = input.substring(0, legalStart);
  const afterStr = input.substring(legalEnd);

  const normalizedBefore = beforeStr
    .split(/(\s+)/)
    .map((part) => (part.trim() ? normalizeWord(part) : part))
    .join('');

  return (normalizedBefore + canonicalForm + afterStr).trim();
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

  // company = canonical-cased string up to (and including) the legal form.
  // We locate the legal form boundary using the lowercase raw input, then
  // apply toTitleCase() so the result is case-invariant.
  const lowerRaw = rawTrimmed.toLowerCase();
  const legalTokenLower = normalized.substring(legal.startIndex, legal.endIndex);

  // Finde letztes Vorkommen mit Wortgrenzen.
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

  let rawCompany: string;
  if (lastIdx === -1) {
    rawCompany = rawTrimmed.substring(0, legal.endIndex).trim();
  } else {
    rawCompany = rawTrimmed.substring(0, lastIdx + legalTokenLower.length).trim();
  }

  const company = normalizeCompanyCasing(rawCompany);

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
