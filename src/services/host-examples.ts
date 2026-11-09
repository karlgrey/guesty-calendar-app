// #1082 Stufe 1: Few-shot aus final gesendeten Host-Nachrichten. Der Entwurfs-Prompt bekam den Ton
// bisher nur aus Regel-Adjektiven der Voice („warm, direkt, kompakt“) — Ergebnis waren Meta-Sätze,
// Floskeln und Begründungsketten, die Micha nie schreibt. Jetzt bekommt er je Nachricht bis zu drei
// echte, so gesendete Antworten Michas als Stil-Vorbild.
//
// Quelle: message_drafts mit outcome unchanged/changed (host-example-repository.ts) — bei changed der
// gesendete Text, nie der Entwurf. Automatisierte Templates (Guesty-/Hostex-Automationen) sind keine
// Drafts und kommen deshalb gar nicht erst in den Kandidatenpool; Auto-Sends (sent_by='auto') fliegen
// in der Abfrage raus.
//
// Auswahl: gleiche Sprache (hart, auch im Fallback — sonst Sprachenmix), gleiches Objekt zuerst,
// Fallback objektübergreifend bei < 3 Treffern. Innerhalb eines Objekts: gleiche Situation zuerst
// (Judge-Kategorie, dann Nachrichten-Kategorie des Threads), dann Wortähnlichkeit der beantworteten
// Gastnachricht, dann Aktualität. Faktenübertrag aus Beispielen verhindert der Prompt-Block
// (ausdrückliche Sperre) plus der unveränderte Judge (contradicts_facts / invents_fact); zusätzlich
// fliegen Beispiele mit langen Ziffernfolgen (Codes, Telefonnummern) ganz raus und Links aus
// fremden Objekten.
import { listHostExampleCandidates, type HostExampleCandidate } from '../repositories/host-example-repository.js';
import { detectLanguage, type SupportedLanguage } from '../utils/language-detect.js';
import type { JudgeCategory } from './auto-send/types.js';

export const HOST_EXAMPLE_COUNT = 3;
/** Kandidatenfenster: gesendete Antworten der letzten 365 Tage, höchstens so viele Zeilen. */
export const HOST_EXAMPLE_WINDOW_DAYS = 365;
export const HOST_EXAMPLE_POOL_LIMIT = 400;
const MIN_BODY_CHARS = 20;
const MAX_BODY_CHARS = 1500;
const GUEST_SNIPPET_CHARS = 280;
// Zugangscodes, Telefonnummern, Buchungsnummern: nie als Vorbild in den Prompt.
const LONG_DIGIT_RUN = /\d{4,}/;
const URL_PATTERN = /https?:\/\/|www\./i;

export interface HostExample {
  body: string;
  guestMessage: string | null;
  sameObject: boolean;
  situationMatch: boolean;
}

export interface HostExampleQuery {
  threadId: string;
  listingId: string;
  source: string;
  guestLanguage: SupportedLanguage;
  /** Die zu beantwortende (letzte) Gastnachricht — Basis der Wortähnlichkeit. */
  lastGuestMessage: string;
  /** Vor dem Entwurf bekannte Judge-Kategorie (heute nur 'buchungsanfrage' aus der Erkennung). */
  judgeCategoryHint: JudgeCategory | null;
  /** Nachrichten-Kategorie des Threads (Classifier, message_threads.conversion_category). */
  conversionCategory: string | null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokens(text: string | null): Set<string> {
  const words = (text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  // ≥ 4 Buchstaben: grober Stopwort-Filter ohne Sprachlisten (der, und, the, can …).
  return new Set(words.filter((w) => w.length >= 4));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
}

function isUsable(c: HostExampleCandidate, sameObject: boolean): boolean {
  const body = c.body.trim();
  if (body.length < MIN_BODY_CHARS || body.length > MAX_BODY_CHARS) return false;
  if (LONG_DIGIT_RUN.test(body)) return false;
  if (!sameObject && URL_PATTERN.test(body)) return false;
  return true;
}

/** Reine Auswahl — Kandidaten in Aktualitäts-Reihenfolge (neueste zuerst), wie das Repository liefert. */
export function selectHostExamples(
  candidates: HostExampleCandidate[],
  q: HostExampleQuery,
  count: number = HOST_EXAMPLE_COUNT,
): HostExample[] {
  const queryTokens = tokens(q.lastGuestMessage);
  const seen = new Set<string>();
  const scored: Array<HostExample & { situation: number; sim: number; idx: number }> = [];
  candidates.forEach((c, idx) => {
    if (c.threadId === q.threadId) return;
    const sameObject = c.listingId === q.listingId && c.source === q.source;
    if (!isUsable(c, sameObject)) return;
    if (detectLanguage(c.body) !== q.guestLanguage) return;
    const key = normalize(c.body);
    if (seen.has(key)) return;
    seen.add(key);
    const situation =
      (q.judgeCategoryHint && c.judgeCategory === q.judgeCategoryHint ? 2 : 0) +
      (q.conversionCategory && c.conversionCategory === q.conversionCategory ? 1 : 0);
    scored.push({
      body: c.body.trim(), guestMessage: c.guestMessage, sameObject, situationMatch: situation > 0,
      situation, sim: similarity(queryTokens, tokens(c.guestMessage)), idx,
    });
  });
  const rank = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    b.situation - a.situation || b.sim - a.sim || a.idx - b.idx;
  const own = scored.filter((s) => s.sameObject).sort(rank);
  const other = scored.filter((s) => !s.sameObject).sort(rank);
  return [...own, ...other].slice(0, count).map(({ body, guestMessage, sameObject, situationMatch }) => ({
    body, guestMessage, sameObject, situationMatch,
  }));
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > GUEST_SNIPPET_CHARS ? `${t.slice(0, GUEST_SNIPPET_CHARS).trimEnd()} …` : t;
}

/** Prompt-Block „So schreibt Micha“ — leer, wenn es keine Beispiele gibt. */
export function buildHostExamplesBlock(examples: HostExample[]): string {
  if (examples.length === 0) return '';
  const lines = [
    '### SO SCHREIBT MICHA — echte Antworten, die Micha genau so an Gäste gesendet hat (NUR Stil-Vorbild) ###',
    'Schreib so wie in diesen Beispielen: Ton, Länge, Satzbau, Wortwahl, Anrede und Gruß. Bei Stilfragen haben sie ' +
      'Vorrang vor den Stil-Adjektiven in der Voice; die harten Regeln oben (LÄNGE, ANTWORTSPRACHE, Sonderregeln) ' +
      'gelten weiter.',
    'KEIN Faktenübertrag: Namen, Daten, Uhrzeiten, Preise, Zahlen, Zusagen, Regeln, Ausstattung und Links aus den ' +
      'Beispielen gehören zu ANDEREN Gästen und teils anderen Objekten. Fakten kommen ausschließlich aus OBJEKTWISSEN, ' +
      'BUCHUNGSKONTEXT und dem Verlauf. Keine Sätze mit Fakten wörtlich übernehmen.',
  ];
  examples.forEach((e, i) => {
    lines.push('', `Beispiel ${i + 1}${e.sameObject ? '' : ' (anderes Objekt)'}:`);
    if (e.guestMessage) lines.push(`Gast schrieb: „${snippet(e.guestMessage)}“`);
    lines.push('Micha antwortete:', e.body);
  });
  lines.push('### ENDE SO SCHREIBT MICHA ###');
  return lines.join('\n');
}

export interface HostExampleDeps {
  list: typeof listHostExampleCandidates;
  now: () => Date;
}
const realDeps: HostExampleDeps = { list: listHostExampleCandidates, now: () => new Date() };

export function findHostExamples(q: HostExampleQuery, deps: HostExampleDeps = realDeps): HostExample[] {
  const since = new Date(deps.now().getTime() - HOST_EXAMPLE_WINDOW_DAYS * 86400000).toISOString();
  const candidates = deps.list({ sinceIso: since, limit: HOST_EXAMPLE_POOL_LIMIT, excludeThreadId: q.threadId });
  return selectHostExamples(candidates, q);
}
