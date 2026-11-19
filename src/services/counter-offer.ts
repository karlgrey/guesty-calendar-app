// src/services/counter-offer.ts
// #1243: Gegenangebot bei Airbnb-Buchungsanfragen (Fall Daniel, 17.11.2026) — reine Funktionen,
// kein I/O, keine DB. Liefert (a) die Aufenthalts-Fakten (Wochentage der Nächte, Abstand der
// Anfrage zur Anreise), (b) die vorsichtige Erkennung eines Betrags in der Gastnachricht,
// (c) die Einordnung gegen den gerade geltenden Gastpreis und die Nachlass-Bedingung der
// Objektregel. Höhe und Wortlaut der Rabatt-Linie stehen NUR im Vault; hier wird nur geprüft,
// OB die Bedingung (Kurzfrist/Wochenende) erfüllt ist. Die Notiz nennt nie die Auszahlung,
// Gebührensätze oder einen ausgerechneten Rabatt-Höchstbetrag.
import { berlinCalendarDay, WEEKDAY_DE_LONG } from './auto-send/berlin-day.js';

export interface DiscountCondition {
  shortNoticeDays: number;
  weekend: boolean;
}

export interface StayFacts {
  requestedAt: string | null; // ISO
  requestDaysBeforeArrival: number | null;
  /** 0=So … 6=Sa, Wochentag jeder Nacht (= Tag des Einschlafens), höchstens 7, chronologisch */
  nightWeekdays: number[];
  /** eine Nacht beginnt Freitag oder Samstag */
  weekendNight: boolean;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** "YYYY-MM-DD…" → UTC-Millisekunden des Kalendertags; null bei ungültigem Datum. */
function dayMs(iso: string | null | undefined): number | null {
  const m = ISO_DAY.exec(iso ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

const DAY_MS = 86_400_000;

export function computeStayFacts(checkInIso: string, checkOutIso: string, requestedAtIso: string | null): StayFacts {
  const inMs = dayMs(checkInIso);
  const outMs = dayMs(checkOutIso);

  let requestedAt: string | null = null;
  let requestDaysBeforeArrival: number | null = null;
  if (requestedAtIso && !Number.isNaN(new Date(requestedAtIso).getTime())) {
    requestedAt = requestedAtIso;
    const reqMs = dayMs(berlinCalendarDay(requestedAtIso));
    if (reqMs != null && inMs != null) {
      const diff = Math.round((inMs - reqMs) / DAY_MS);
      requestDaysBeforeArrival = diff >= 0 ? diff : null;
    }
  }

  const nightWeekdays: number[] = [];
  if (inMs != null && outMs != null && outMs > inMs) {
    for (let t = inMs; t < outMs && nightWeekdays.length < 7; t += DAY_MS) {
      nightWeekdays.push(new Date(t).getUTCDay());
    }
  }
  return {
    requestedAt,
    requestDaysBeforeArrival,
    nightWeekdays,
    weekendNight: nightWeekdays.some((d) => d === 5 || d === 6),
  };
}

function deDay(iso: string): string {
  const [y, m, d] = berlinCalendarDay(iso).split('-');
  return `${d}.${m}.${y}`;
}

function daysBeforeLabel(n: number): string {
  if (n === 0) return 'am Anreisetag';
  return n === 1 ? '1 Tag vor Anreise' : `${n} Tage vor Anreise`;
}

/** Deutscher Satz für den Entwurfs-Kontext (Anfrage-Zeitpunkt + Wochentage der Nächte). */
export function formatStayFactsSentence(f: StayFacts): string {
  const parts: string[] = [];
  if (f.requestedAt) {
    const days = f.requestDaysBeforeArrival != null ? `, ${daysBeforeLabel(f.requestDaysBeforeArrival)}` : '';
    parts.push(`Anfrage gestellt am ${deDay(f.requestedAt)}${days}.`);
  }
  if (f.nightWeekdays.length) {
    const weekend = `(Wochenendnacht Fr/Sa dabei: ${f.weekendNight ? 'ja' : 'nein'})`;
    if (f.nightWeekdays.length >= 7) {
      parts.push(`Übernachtungen an allen Wochentagen ${weekend}.`);
    } else {
      parts.push(`Übernachtungen in den Nächten ab ${f.nightWeekdays.map((d) => WEEKDAY_DE_LONG[d]).join(', ')} ${weekend}.`);
    }
  }
  return parts.join(' ');
}

// ---- Betrags-Erkennung ----------------------------------------------------------------------

const NUM = String.raw`\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CUR = String.raw`(?:€|\beur(?:os?)?\b)`;
const AMOUNT_RE = new RegExp(String.raw`${CUR}\s*(?<![\d.,])(${NUM})(?![\d])|(?<![\d.,])(${NUM})(?![\d])\s*${CUR}`, 'gi');

// Pro-Einheit-Beträge sind kein Gesamtgebot.
const PER_UNIT = /pro\s+nacht|per\s+night|\/\s*nacht|\/\s*night|die\s+nacht|a\s+night|pro\s+person|per\s+person|p\.\s*p\.|\bpp\b/i;
// Nachlass- oder Nebenbeträge statt Gesamtgebot.
const NOT_TOTAL = /rabatt|nachlass|weniger|günstiger|billiger|\boff\b|discount|\bless\b|reduz|kaution|deposit/i;
const WINDOW = 30;

/** "2.600,50" / "2,600" / "2600.00" / "2 600" → Zahl (Komma + genau 3 Ziffern = Tausender). */
function parseNumber(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    normalized = s.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const tail = s.slice(s.lastIndexOf(sep) + 1);
    normalized = count > 1 || tail.length === 3 ? s.split(sep).join('') : s.replace(sep, '.');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Betrag MIT Währungsmarker in einer Gastnachricht. "Im Zweifel nichts": null bei keinem Betrag,
 * mehreren unterschiedlichen Beträgen, Pro-Einheit-Betrag, Nachlass-/Kaution-Kontext oder Betrag ≤ 0.
 */
export function detectCounterOfferAmount(text: string): number | null {
  const amounts = new Set<number>();
  for (const m of (text ?? '').matchAll(AMOUNT_RE)) {
    const value = parseNumber(m[1] ?? m[2]);
    if (value == null) return null;
    const start = m.index ?? 0;
    const around = text.slice(Math.max(0, start - WINDOW), start + m[0].length + WINDOW);
    if (PER_UNIT.test(around) || NOT_TOTAL.test(around)) return null;
    amounts.add(value);
  }
  if (amounts.size !== 1) return null;
  const [value] = amounts;
  return value > 0 ? value : null;
}

// ---- Einordnung -----------------------------------------------------------------------------

export interface CounterOfferEvaluation {
  offer: number;
  guestTotal: number;
  currency: string | null;
  diffAbs: number;
  diffPct: number;
  condition: { met: boolean; shortNotice: boolean; weekend: boolean } | null;
}

/**
 * #1243: Bedingung der Objekt-Rabattlinie (properties.json `airbnbDiscount`): Anreise höchstens
 * shortNoticeDays Tage nach der Anfrage ODER (wenn weekend) eine Nacht ab Freitag/Samstag.
 */
export function evaluateDiscountCondition(
  stay: StayFacts, rule: DiscountCondition,
): { met: boolean; shortNotice: boolean; weekend: boolean } {
  const days = stay.requestDaysBeforeArrival;
  const shortNotice = days != null && days <= rule.shortNoticeDays;
  const weekend = rule.weekend && stay.weekendNight;
  return { met: shortNotice || weekend, shortNotice, weekend };
}

function conditionDetail(stay: StayFacts, weekend: boolean): string {
  const days = stay.requestDaysBeforeArrival;
  const daysPart = days != null ? `Anfrage ${daysBeforeLabel(days)}` : 'Abstand Anfrage–Anreise unbekannt';
  return `${weekend ? 'Wochenende' : 'kein Wochenende'}, ${daysPart}`;
}

/**
 * #1243: ausgewertete Bedingung als Fakt-Satz für den Entwurfs-/Judge-Kontext — der Entwurf prüft
 * die Bedingung nicht selbst nach (Live-Test: Sonnet bot bei 26 Tagen Vorlauf ohne Wochenende
 * trotzdem einen Nachlass an). Nennt keine Rabatthöhe; die steht nur im Objektwissen.
 */
export function formatDiscountConditionSentence(stay: StayFacts, rule: DiscountCondition): string {
  const c = evaluateDiscountCondition(stay, rule);
  return `Nachlass-Bedingung laut Objektregel: ${c.met ? 'erfüllt' : 'nicht erfüllt'} (${conditionDetail(stay, c.weekend)}).`;
}

/** #1243: kleinster Anteil am Gastbetrag, ab dem ein erkannter Betrag als Gesamtgebot gilt. */
export const MIN_OFFER_SHARE = 0.5;

export function evaluateCounterOffer(a: {
  offer: number; guestTotal: number; currency: string | null; stay: StayFacts; rule: DiscountCondition | null;
}): CounterOfferEvaluation | null {
  if (!(a.guestTotal > 0) || a.offer >= a.guestTotal) return null;
  // #1243 (Prüfer-Befund 4): Nebenbeträge („Kostet der Hund 30 € extra?“, „Endreinigung 390 € ist ok“) sind kein
  // Gegenangebot — „wenn nicht sicher erkennbar, nichts anzeigen“. Plausibilitätsgrenze relativ zum Gastbetrag,
  // reine Erkennungs-Heuristik (keine Rabattzahl): ein Gesamtgebot unter der Hälfte gilt als nicht sicher erkannt.
  if (a.offer < a.guestTotal * MIN_OFFER_SHARE) return null;
  const diffAbs = Math.round((a.guestTotal - a.offer) * 100) / 100;
  const diffPct = Math.round((diffAbs / a.guestTotal) * 1000) / 10;
  const condition = a.rule ? evaluateDiscountCondition(a.stay, a.rule) : null;
  return { offer: a.offer, guestTotal: a.guestTotal, currency: a.currency, diffAbs, diffPct, condition };
}

/** Betrag deutsch formatiert: ganze Beträge ohne Nachkommastellen, sonst zwei (Muster formatMoney in den Routen). */
function formatMoney(amount: number, currency: string | null): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  if (currency) {
    try {
      return new Intl.NumberFormat('de-DE', {
        style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(amount).replace(/ /g, ' ');
    } catch {
      // unbekannter Währungscode → Zahl + Code
    }
  }
  const n = new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  return currency ? `${n} ${currency}` : n;
}

/** Eine Klartext-Zeile; nennt nie Auszahlung, Gebührensätze oder einen Rabatt-Höchstbetrag. */
export function formatCounterOfferNote(e: CounterOfferEvaluation, estimated: boolean, stay: StayFacts): string {
  const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(e.diffPct);
  let note =
    `Betrag in der Gastnachricht ${formatMoney(e.offer, e.currency)} (mögliches Gegenangebot): ` +
    `${formatMoney(e.diffAbs, e.currency)} bzw. ${pct} % unter dem Gastpreis ` +
    `${estimated ? 'ca. ' : ''}${formatMoney(e.guestTotal, e.currency)} inkl. Steuern`;
  if (e.condition) {
    note += ` · Nachlass-Bedingung laut Objektregel: ${e.condition.met ? 'erfüllt' : 'nicht erfüllt'} (${conditionDetail(stay, e.condition.weekend)})`;
  }
  return note;
}
