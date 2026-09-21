// Modellunabhängige Schicht des Auto-Send-Gates (Spec 5.2): reine String-Regeln, kein I/O.
import type { MechanicalFinding } from './types.js';
import { detectLanguage, type SupportedLanguage } from '../../utils/language-detect.js';

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

export function collectDigitRuns(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(DIGIT_RUN)) out.add(m[0]);
  return [...out];
}

export function runMechanicalChecks(
  body: string,
  // #695: guestLanguage optional (Rückwärtskompatibilität bestehender Aufrufer/Tests) — ohne
  // sie läuft der Sprach-Check nicht (Verhalten unverändert).
  // #697: isBookingRequest optional — nur bei Buchungsanfragen läuft der zusätzliche
  // Bestätigungswort-Check (eine Rückfrage darf nie wie eine Zusage klingen).
  context: { knownDigitRuns: string[]; guestLanguage?: SupportedLanguage; isBookingRequest?: boolean },
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
  return f;
}
