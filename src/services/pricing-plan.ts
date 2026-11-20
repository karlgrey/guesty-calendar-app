/**
 * Preisplan für die Agent-API: Validierung, Tagesauswahl, Änderungsplan und
 * Gruppierung in Schreibbereiche (Guesty/Hostex). Reine Funktionen, keine I/O.
 * Datumsstrings YYYY-MM-DD, UTC-Arithmetik.
 */
import { ValidationError } from '../utils/errors.js';

export const PRICING_MAX_RANGE_DAYS = 730;
export const PRICING_MAX_PRICE = 10000;
export const PRICING_MAX_FACTOR = 3;
export const PRICING_MAX_MIN_NIGHTS = 365;

export interface PricingDay {
  date: string;
  price: number | null;
  minNights: number | null;
  occupied: boolean;
  occupiedReason?: string;
}

export interface PricingRequest {
  from: string;
  to: string;
  price?: number;
  factor?: number;
  minNights?: number;
  weekdays?: number[];
  dryRun: boolean;
  caller?: string;
}

export interface PricingChange {
  date: string;
  price?: { old: number | null; new: number };
  minNights?: { old: number | null; new: number };
}
export interface PricingSkip { date: string; reason: string }
export interface PricingPlan {
  changes: PricingChange[];
  unchanged: string[];
  skipped: PricingSkip[];
  selectedDays: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, n: number): string {
  return new Date(toUtc(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Anzahl Tage von..bis, beide inklusive. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1;
}

/** ISO-Wochentag: 1 = Montag … 7 = Sonntag. */
export function isoWeekday(date: string): number {
  const d = new Date(toUtc(date)).getUTCDay(); // 0 = Sonntag
  return d === 0 ? 7 : d;
}

/** Alle Tage from..to (inklusive), optional nach ISO-Wochentag gefiltert. */
export function selectDates(from: string, to: string, weekdays?: number[]): string[] {
  const out: string[] = [];
  const n = daysInclusive(from, to);
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i);
    if (!weekdays || weekdays.includes(isoWeekday(d))) out.push(d);
  }
  return out;
}

function isRealDate(s: string): boolean {
  return DATE_RE.test(s) && new Date(toUtc(s)).toISOString().slice(0, 10) === s;
}

export function validatePricingRange(from: unknown, to: unknown, label = ''): { from: string; to: string } {
  const prefix = label ? `${label}: ` : '';
  for (const [name, v] of [['from', from], ['to', to]] as const) {
    if (typeof v !== 'string' || !isRealDate(v)) {
      throw new ValidationError(`${prefix}${name} muss ein gültiges Datum im Format YYYY-MM-DD sein`);
    }
  }
  const f = from as string;
  const t = to as string;
  if (f > t) throw new ValidationError(`${prefix}from (${f}) liegt nach to (${t})`);
  const days = daysInclusive(f, t);
  if (days > PRICING_MAX_RANGE_DAYS) {
    throw new ValidationError(`${prefix}Zeitraum zu lang: maximal ${PRICING_MAX_RANGE_DAYS} Tage, angefragt ${days}`);
  }
  return { from: f, to: t };
}

const ALLOWED_KEYS = ['from', 'to', 'price', 'factor', 'minNights', 'weekdays', 'dryRun', 'caller'];
/** #1305: Grundpreis des Listings wird allein gesetzt, ohne Datumsbereich und ohne Tageswerte. */
const BASE_PRICE_KEYS = ['basePrice', 'dryRun', 'caller'];

export interface BasePriceRequest {
  basePrice: number;
  dryRun: boolean;
  caller?: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function parsePricingRequest(body: unknown, todayBerlin: string): PricingRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request-Body muss ein JSON-Objekt sein');
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new ValidationError(`Unbekannter Schlüssel "${key}". Erlaubt: ${ALLOWED_KEYS.join(', ')} (Grundpreis: basePrice allein, mit dryRun/caller)`);
    }
  }
  const { from, to } = validatePricingRange(b.from, b.to);
  if (to < todayBerlin) {
    throw new ValidationError(`Zeitraum liegt komplett in der Vergangenheit (to ${to} < heute ${todayBerlin})`);
  }
  if (b.price !== undefined && b.factor !== undefined) {
    throw new ValidationError('price und factor schließen sich aus');
  }
  if (b.price === undefined && b.factor === undefined && b.minNights === undefined) {
    throw new ValidationError('Mindestens eines von price, factor oder minNights ist nötig');
  }
  const req: PricingRequest = { from, to, dryRun: false };

  if (b.price !== undefined) req.price = parseAmount(b.price, 'price');
  if (b.factor !== undefined) {
    const f = b.factor;
    if (!isFiniteNumber(f) || f <= 0 || f > PRICING_MAX_FACTOR) {
      throw new ValidationError(`factor muss eine Zahl > 0 und ≤ ${PRICING_MAX_FACTOR} sein`);
    }
    req.factor = f;
  }
  if (b.minNights !== undefined) {
    const m = b.minNights;
    if (!isFiniteNumber(m) || !Number.isInteger(m) || m < 1 || m > PRICING_MAX_MIN_NIGHTS) {
      throw new ValidationError(`minNights muss eine Ganzzahl zwischen 1 und ${PRICING_MAX_MIN_NIGHTS} sein`);
    }
    req.minNights = m;
  }
  if (b.weekdays !== undefined) {
    const w = b.weekdays;
    if (!Array.isArray(w) || w.length === 0 || !w.every((x) => isFiniteNumber(x) && Number.isInteger(x) && x >= 1 && x <= 7)) {
      throw new ValidationError('weekdays muss ein nicht-leeres Array von Ganzzahlen 1 (Mo) bis 7 (So) sein');
    }
    req.weekdays = [...new Set(w as number[])].sort((a, c) => a - c);
  }
  req.dryRun = parseDryRun(b.dryRun);
  const caller = parseCaller(b.caller);
  if (caller) req.caller = caller;
  return req;
}

/** Betrag in Euro: > 0, ≤ PRICING_MAX_PRICE, höchstens zwei Nachkommastellen (price und basePrice). */
function parseAmount(p: unknown, name: string): number {
  if (!isFiniteNumber(p) || p <= 0 || p > PRICING_MAX_PRICE) {
    throw new ValidationError(`${name} muss eine Zahl > 0 und ≤ ${PRICING_MAX_PRICE} sein`);
  }
  if (Math.abs(p * 100 - Math.round(p * 100)) >= 1e-9) {
    throw new ValidationError(`${name} darf höchstens zwei Nachkommastellen haben`);
  }
  return p;
}

function parseDryRun(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new ValidationError('dryRun muss ein Boolean sein');
  return v;
}

function parseCaller(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ValidationError('caller muss ein String mit höchstens 100 Zeichen sein');
  const c = v.trim();
  if (c.length > 100) throw new ValidationError('caller muss ein String mit höchstens 100 Zeichen sein');
  return c || undefined;
}

/** Enthält der Body `basePrice`? Dann gilt parseBasePriceRequest statt parsePricingRequest (#1305). */
export function isBasePriceBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'basePrice' in body;
}

/**
 * #1305: Grundpreis des Listings (Guesty Financials `basePrice`). Wird allein gesetzt:
 * from/to/price/factor/minNights/weekdays im selben Aufruf → 400 (Tageswerte bleiben unberührt,
 * ein Aufruf hat genau eine Wirkung).
 */
export function parseBasePriceRequest(body: unknown): BasePriceRequest {
  if (!isBasePriceBody(body)) throw new ValidationError('Request-Body muss ein JSON-Objekt mit basePrice sein');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!BASE_PRICE_KEYS.includes(key)) {
      throw new ValidationError(
        `basePrice wird allein gesetzt (erlaubt: ${BASE_PRICE_KEYS.join(', ')}), nicht zusammen mit "${key}". `
        + 'Tagespreise und Mindestnächte in einem eigenen Aufruf mit from/to setzen',
      );
    }
  }
  const req: BasePriceRequest = { basePrice: parseAmount(b.basePrice, 'basePrice'), dryRun: parseDryRun(b.dryRun) };
  const caller = parseCaller(b.caller);
  if (caller) req.caller = caller;
  return req;
}

/** Faktor auf Altpreis, ganze Euro (kaufmännisch). */
export function applyFactor(oldPrice: number, factor: number): number {
  return Math.round(Number((oldPrice * factor).toFixed(6)));
}

export function planPricingChanges(days: PricingDay[], req: PricingRequest, todayBerlin: string): PricingPlan {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const selected = selectDates(req.from, req.to, req.weekdays);
  const plan: PricingPlan = { changes: [], unchanged: [], skipped: [], selectedDays: selected.length };

  for (const date of selected) {
    if (date < todayBerlin) { plan.skipped.push({ date, reason: 'Tag liegt in der Vergangenheit' }); continue; }
    const day = byDate.get(date);
    if (!day) { plan.skipped.push({ date, reason: 'kein Kalendertag vom Anbieter' }); continue; }
    if (day.occupied) { plan.skipped.push({ date, reason: day.occupiedReason ?? 'belegt (Reservierung)' }); continue; }
    if (req.factor !== undefined && day.price === null) {
      plan.skipped.push({ date, reason: 'kein aktueller Preis für factor' });
      continue;
    }

    let newPrice: number | undefined;
    if (req.price !== undefined) newPrice = req.price;
    else if (req.factor !== undefined) newPrice = applyFactor(day.price as number, req.factor);
    // factor rundet auf ganze Euro: ein Ergebnis von 0 darf nie als Preis rausgehen (Kriterium „Preis > 0“).
    if (newPrice !== undefined && newPrice <= 0) {
      plan.skipped.push({ date, reason: `factor ergibt keinen Preis über 0 (alt ${day.price})` });
      continue;
    }
    const newMin = req.minNights;

    const priceSame = newPrice === undefined || day.price === newPrice;
    const minSame = newMin === undefined || day.minNights === newMin;
    if (priceSame && minSame) { plan.unchanged.push(date); continue; }

    const change: PricingChange = { date };
    if (newPrice !== undefined) change.price = { old: day.price, new: newPrice };
    if (newMin !== undefined) change.minNights = { old: day.minNights, new: newMin };
    plan.changes.push(change);
  }
  return plan;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Aufeinanderfolgende Tage mit gleichem Payload → ein Lauf (Grenzen inklusive). */
export function groupWriteRuns<P extends object>(
  items: Array<{ date: string; payload: P }>,
): Array<{ from: string; to: string; nights: number; payload: P }> {
  const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const runs: Array<{ from: string; to: string; nights: number; payload: P }> = [];
  let lastKey = '';
  for (const it of sorted) {
    const key = stableStringify(it.payload);
    const last = runs[runs.length - 1];
    if (last && key === lastKey && addDays(last.to, 1) === it.date) { last.to = it.date; last.nights += 1; }
    else { runs.push({ from: it.date, to: it.date, nights: 1, payload: it.payload }); lastKey = key; }
  }
  return runs;
}
