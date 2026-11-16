// Modellunabhängige Schicht des Auto-Send-Gates (Spec 5.2): reine String-Regeln, kein I/O.
import type { MechanicalFinding } from './types.js';
import { detectLanguage, type SupportedLanguage } from '../../utils/language-detect.js';
import { allowedWeekdays } from './today-facts.js';
import { stripGreetingAndClosing } from '../draft-fixture-check.js';

export const MAX_DRAFT_LENGTH = 1200;
const DIGIT_RUN = /\d{4,}/g;
// #686 Nachzieh-Liste: auch schemelose Domains mit Pfad (z. B. „farmhouse-prasser.de/x“) fangen —
// der Pfad-Slash ist die Abgrenzung gegen normale Sätze mit Punkt (Abkürzungen „z.B.“/„bzw.“,
// Dezimalzahlen „12.50“/„1.200“), die nie von einem „/“ gefolgt werden.
const URL = /https?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MONEY = /€|\bEUR\b|\bEUR\s*\d|\bEuro\b|\d+,\d{2}\b/;
const PHONE = /\+\d[\d\s/-]{5,}|\b0\d{2,4}[\s/-]?\d{2,}[\s/-]?\d{2,}(?:[\s/-]?\d{2,})?/;
const CODE_WORDS = /\b(Code|PIN|Tresor|Schlüsselbox|Schloss)\b/i;
const NUMBER_WORDS = /\b(null|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
// #697: Bestätigungs-/Zusagewörter — nur relevant im Buchungsanfrage-Kontext (eine Rückfrage
// darf niemals wie eine Bestätigung/Zusage klingen, DE+EN, Spec-Änderung Micha 21.09.2026).
// Bewusst NUR Verben/Partizipien: das Substantiv „Bestätigung“ ist Pflichtinhalt der Rückfrage
// („die endgültige Bestätigung läuft über Airbnb“) und darf nicht stoppen (Review Hauptsession 21.09.).
const CONFIRMATION_WORDS = /\b(bestätigt|bestätige|bestätigen|angenommen|confirm(ed)?|accepted)\b/i;
const NOTHING_IN_THE_WAY = /steht[^.!?]{0,60}nichts im weg/i;
// #698 (Fall Lorenzo U19, 20.09.2026): Wochentagsnamen DE lang + EN, nur relevant wenn der
// Check mit `now` läuft. Bewusst OHNE trailing Wortgrenze (`\b<Name>` statt `\b<Name>\b`), damit
// Komposita wie „Sonntagabend“/„Sunday evening“ ebenfalls matchen — bei den deutschen Namen gibt
// es keine bekannten Wörter, die zufällig mit einem Wochentagsnamen beginnen; bei den englischen
// ist z. B. „Mondays“ als Treffer ausdrücklich in Ordnung (Spec). Einzige deutsche Kollision
// (Review Hauptsession 25.09.): „Montage“/„Montagearbeiten“ beginnt mit „Montag“ — deshalb dort
// ein negatives Lookahead auf „e“ („Montagabend“/„Montags“ matchen weiterhin).
const WEEKDAY_NAMES: Array<{ name: string; index: number }> = [
  { name: 'Sonntag', index: 0 }, { name: 'Montag(?!e)', index: 1 }, { name: 'Dienstag', index: 2 },
  { name: 'Mittwoch', index: 3 }, { name: 'Donnerstag', index: 4 }, { name: 'Freitag', index: 5 },
  { name: 'Samstag', index: 6 },
  { name: 'Sunday', index: 0 }, { name: 'Monday', index: 1 }, { name: 'Tuesday', index: 2 },
  { name: 'Wednesday', index: 3 }, { name: 'Thursday', index: 4 }, { name: 'Friday', index: 5 },
  { name: 'Saturday', index: 6 },
];

export function collectDigitRuns(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(DIGIT_RUN)) out.add(m[0]);
  return [...out];
}

// #1191: Satzwiederholung gegenüber den letzten gesendeten Host-Nachrichten.
export const REPEAT_MIN_WORDS = 5;
export const REPEAT_JACCARD_THRESHOLD = 0.8;

/** NFC, klein, alles außer Buchstaben/Ziffern/Whitespace (Satzzeichen, Emojis, Anführungszeichen) → Leerzeichen. */
export function normalizeSentence(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const SENTENCE_SPLIT = /(?<=[.!?…])\s+|\n+/;

/**
 * Text ohne Anrede-Zeile und Grußformel. stripGreetingAndClosing schneidet ab der ERSTEN Zeile ab,
 * die wie ein Gruß beginnt — auch bei „Herzlich willkommen! …" oder „Bis bald …" mitten im Text;
 * alles dahinter bliebe ungeprüft (Review #1191). Deshalb wird der abgeschnittene Rest zeilenweise
 * wieder aufgenommen: von einer Gruß-/Anrede-Zeile entfällt nur der erste Satz (die Formel selbst),
 * jede andere Zeile zählt normal.
 */
function textForRepeatCheck(text: string): string {
  const full = text.replace(/\r\n/g, '\n');
  const stripped = stripGreetingAndClosing(full);
  const at = full.indexOf(stripped);
  if (at < 0) return stripped;
  const rest = full.slice(at + stripped.length).split('\n').filter((l) => l.trim())
    .map((line) => (stripGreetingAndClosing(line) === '' ? line.split(SENTENCE_SPLIT).slice(1).join(' ') : line));
  return [stripped, ...rest].join('\n');
}

/** Sätze ohne Anrede-Zeile/Grußformel, normalisiert, nur mit ≥ REPEAT_MIN_WORDS Wörtern. */
export function ownSentences(text: string): { raw: string; norm: string; tokens: Set<string> }[] {
  const out: { raw: string; norm: string; tokens: Set<string> }[] = [];
  for (const part of textForRepeatCheck(text ?? '').split(SENTENCE_SPLIT)) {
    const raw = part.trim();
    const norm = normalizeSentence(raw);
    if (!norm) continue;
    const words = norm.split(' ');
    if (words.length < REPEAT_MIN_WORDS) continue;
    out.push({ raw, norm, tokens: new Set(words) });
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Erster Entwurfssatz (Original, getrimmt), der einen Host-Satz exakt (normalisiert) oder per Token-Jaccard ≥ 0,8 wiederholt. */
export function findRepeatedOwnSentence(body: string, hostMessages: string[]): string | null {
  const hostSentences = hostMessages.flatMap((m) => ownSentences(m));
  if (!hostSentences.length) return null;
  for (const d of ownSentences(body)) {
    for (const h of hostSentences) {
      if (d.norm === h.norm || jaccard(d.tokens, h.tokens) >= REPEAT_JACCARD_THRESHOLD) return d.raw;
    }
  }
  return null;
}

export function runMechanicalChecks(
  body: string,
  // #695: guestLanguage optional (Rückwärtskompatibilität bestehender Aufrufer/Tests) — ohne
  // sie läuft der Sprach-Check nicht (Verhalten unverändert).
  // #697: isBookingRequest optional — nur bei Buchungsanfragen läuft der zusätzliche
  // Bestätigungswort-Check (eine Rückfrage darf nie wie eine Zusage klingen).
  // #698: now optional (Rückwärtskompatibilität, Muster wie guestLanguage) — nur wenn gesetzt,
  // läuft der Wochentags-Check; bookingContext geht dabei nur in allowedWeekdays ein (Stay-Tage).
  context: {
    knownDigitRuns: string[]; guestLanguage?: SupportedLanguage; isBookingRequest?: boolean;
    now?: Date; bookingContext?: string | null;
    // #1191: die zuletzt gesendeten Host-Nachrichten — fehlt/leer → kein Wiederholungs-Check.
    recentHostMessages?: string[];
  },
): MechanicalFinding[] {
  const f: MechanicalFinding[] = [];
  const text = body ?? '';
  if (!text.trim()) return [{ flag: 'empty', match: '' }];
  if (text.length > MAX_DRAFT_LENGTH) f.push({ flag: 'length', match: `${text.length} Zeichen` });
  if (context.guestLanguage) {
    const draftLanguage = detectLanguage(text);
    if (draftLanguage !== context.guestLanguage) {
      f.push({ flag: 'language_mismatch', match: draftLanguage });
    }
  }
  const known = new Set(context.knownDigitRuns);
  for (const m of text.matchAll(DIGIT_RUN)) if (!known.has(m[0])) { f.push({ flag: 'digits', match: m[0] }); break; }
  const url = text.match(URL); if (url) f.push({ flag: 'url', match: url[0] });
  const mail = text.match(EMAIL); if (mail) f.push({ flag: 'email', match: mail[0] });
  const money = text.match(MONEY); if (money) f.push({ flag: 'money', match: money[0] });
  const phone = text.match(PHONE); if (phone) f.push({ flag: 'phone', match: phone[0].trim() });
  // Code-Wort + Ziffer oder ausgeschriebenes Zahlwort im selben Satz
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (CODE_WORDS.test(sentence) && (/\d/.test(sentence) || NUMBER_WORDS.test(sentence))) {
      f.push({ flag: 'code_words', match: sentence.trim().slice(0, 80) });
      break;
    }
  }
  if (context.isBookingRequest) {
    const match = text.match(CONFIRMATION_WORDS) ?? text.match(NOTHING_IN_THE_WAY);
    if (match) f.push({ flag: 'confirmation_words', match: match[0] });
  }
  if (context.now) {
    const allowed = allowedWeekdays(context.now, context.bookingContext ?? null);
    for (const wd of WEEKDAY_NAMES) {
      const m = text.match(new RegExp(`\\b${wd.name}`, 'i'));
      if (m && !allowed.has(wd.index)) { f.push({ flag: 'zeitbezug_veraltet', match: m[0] }); break; }
    }
  }
  if (context.recentHostMessages?.length) {
    const repeated = findRepeatedOwnSentence(text, context.recentHostMessages);
    if (repeated) f.push({ flag: 'repeats_own_sentence', match: repeated.slice(0, 80) });
  }
  return f;
}
