// #976: reine Prüffunktionen für die Entwurfs-Regressions-Fixtures (src/test-fixtures/drafts/cases.json,
// Live-Lauf: npm run test:drafts). Kein I/O — Satzzählung und Erwartungsprüfung sind hier getestet,
// das Skript ruft nur noch das Modell auf.
import type { DraftResult } from './draft-service.js';

export interface DraftExpectation {
  /** true → pass nur bei kind==='no_reply'; sonst muss kind==='text' sein. */
  noReply?: boolean;
  maxSentences?: number;
  /** Zeichen ohne Anrede-/Grußzeilen. */
  maxChars?: number;
  /** mind. eins muss vorkommen (case-insensitive). */
  mustContainAny?: string[];
  /** keins darf vorkommen (case-insensitive). */
  mustNotContain?: string[];
}

const GREETING_RE = /^\s*(hallo|hi|hey|hallöchen|liebe[rs]?|lieber|guten\s+(tag|morgen|abend)|moin|servus|hello|dear|ciao|buongiorno|hola|bonjour)\b[^.!?\n]*[,!]?\s*$/i;
const CLOSING_START_RE = /^\s*(liebe[rn]?\s+gr(ü|ue)(ß|ss)e|viele\s+gr(ü|ue)(ß|ss)e|herzliche[rn]?\s+gr(ü|ue)(ß|ss)e|beste\s+gr(ü|ue)(ß|ss)e|sonnige\s+gr(ü|ue)(ß|ss)e|gr(ü|ue)(ß|ss)e|lg|vg|bis\s+bald|herzlichst|herzlich|best\s+regards|kind\s+regards|regards|cheers|warm\s+regards|a\s+presto|saluti|cordiali\s+saluti|saludos|cordialement)\b/i;

/** Entfernt Anrede-Zeile (erste Zeile) und Grußblock (ab der ersten Grußzeile bis zum Ende). */
export function stripGreetingAndClosing(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start < lines.length && GREETING_RE.test(lines[start])) start++;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (CLOSING_START_RE.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

const ABBREVIATIONS = [
  'z. B', 'z.B', 'd. h', 'd.h', 'u. a', 'u.a', 'u. U', 'ca', 'bzw', 'nr', 'usw', 'etc', 'evtl', 'ggf', 'inkl', 'max', 'min',
  'std', 'tel', 'str', 'vgl', 'sog', 'ggfs', 'zzgl', 'exkl', 'mind', 'o. ä', 'o.ä', 'e. g', 'i. e', 'approx', 'incl', 'mr', 'mrs', 'dr', 'prof',
];
const MONTHS = 'januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mär|apr|jun|jul|aug|sep|sept|okt|nov|dez';
const PROTECT = '\u0001';

function protectNonBoundaries(text: string): string {
  let t = text;
  // Abkürzungen (auch mit Leerzeichen in „z. B.“): Punkt maskieren
  for (const ab of ABBREVIATIONS) {
    const pattern = ab.split('').map((c) => c === ' ' ? '\\s?' : c === '.' ? '\\.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    const re = new RegExp(`(^|[^\\p{L}])(${pattern})\\.`, 'giu');
    t = t.replace(re, (_m, pre: string, word: string) => `${pre}${word.replace(/\./g, PROTECT)}${PROTECT}`);
  }
  // Zahl.Zahl.(Zahl) — Datum/Dezimal/Uhrzeit: alle Punkte zwischen Ziffern maskieren
  t = t.replace(/(\d)\.(?=\d)/g, `$1${PROTECT}`);
  // Datum mit Schlusspunkt „20.11.“ → Schlusspunkt nach Ziffer, wenn davor Ziffer.Ziffer
  t = t.replace(/(\d{1,2}\u0001\d{1,2})\./g, `$1${PROTECT}`);
  // Ordinalzahl vor Monatsnamen/Kleinbuchstaben: „am 20. November“, „der 3. und 4.“
  t = t.replace(new RegExp(`(\\d)\\.(?=\\s+(?:${MONTHS})\\b)`, 'giu'), `$1${PROTECT}`);
  t = t.replace(/(\d)\.(?=\s+\p{Ll})/gu, `$1${PROTECT}`);
  return t;
}

/** Zählt Sätze (Satzende . ! ? … gefolgt von Leerraum/Ende) ohne Anrede- und Grußzeilen. */
export function countSentences(text: string): number {
  const body = stripGreetingAndClosing(text);
  if (!body) return 0;
  const protectedText = protectNonBoundaries(body);
  const segments = protectedText.split(/[.!?…]+(?=\s|$)/u);
  return segments.filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

export function checkDraftExpectation(result: DraftResult, expect: DraftExpectation): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (expect.noReply) {
    if (result.kind !== 'no_reply') failures.push(`erwartet no_reply, bekommen ${result.kind}`);
    return { pass: failures.length === 0, failures };
  }
  if (result.kind !== 'text') {
    failures.push(`erwartet text, bekommen ${result.kind}`);
    return { pass: false, failures };
  }
  const body = result.body;
  const lower = body.toLowerCase();
  if (expect.maxSentences !== undefined) {
    const n = countSentences(body);
    if (n > expect.maxSentences) failures.push(`${n} Sätze > maxSentences ${expect.maxSentences}`);
  }
  if (expect.maxChars !== undefined) {
    const n = stripGreetingAndClosing(body).length;
    if (n > expect.maxChars) failures.push(`${n} Zeichen > maxChars ${expect.maxChars}`);
  }
  if (expect.mustContainAny && expect.mustContainAny.length > 0) {
    if (!expect.mustContainAny.some((s) => lower.includes(s.toLowerCase()))) {
      failures.push(`keiner der Pflichtbegriffe enthalten: ${expect.mustContainAny.join(' | ')}`);
    }
  }
  for (const s of expect.mustNotContain ?? []) {
    if (lower.includes(s.toLowerCase())) failures.push(`verbotener Begriff enthalten: „${s}“`);
  }
  return { pass: failures.length === 0, failures };
}
