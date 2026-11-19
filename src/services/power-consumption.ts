/**
 * Stromverbrauch je Buchung (#1169) — PURE Berechnung, kein I/O.
 *
 * - Verbrauch = Stand zur Check-out-Zeit minus Stand zur Check-in-Zeit.
 * - Stand zum Zeitpunkt: lineare Interpolation zwischen letztem Stand davor und erstem danach,
 *   wenn beide höchstens 3 Stunden auseinanderliegen; sonst „unvollständig“ (Lücke).
 * - Sinkt der Zählerstand im Zeitraum (Zählertausch/Reset) → „unvollständig“ (Reset).
 * - Leerstand zwischen Check-out und nächstem Check-in = eigene Zeile (kWh, kWh/Tag).
 * - Auffällig = kWh/Nacht > Median der vollständig erfassten Buchungen × 1,5, erst ab
 *   5 Vergleichsbuchungen.
 * - Laufende Buchung/Leerstand (Ende nach „jetzt“): Verbrauch bis zum letzten Zählerstand,
 *   zählt nicht in den Median.
 */

export const MAX_INTERPOLATION_GAP_MS = 3 * 60 * 60 * 1000;
export const FLAG_THRESHOLD_FACTOR = 1.5;
export const MIN_COMPARISON_STAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Laufende Zeilen bekommen erst ab einem vollen Tag einen Pro-Nacht-/Pro-Tag-Wert (sonst Rauschen). */
const MIN_RUNNING_SPAN_MS = DAY_MS;

export interface ReadingPoint {
  /** UTC-ISO */
  measuredAt: string;
  kwh: number;
}

export interface StayInput {
  reservationId: string;
  guestName: string | null;
  /** lokales Datum YYYY-MM-DD (Anzeige) */
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  /** effektive Check-in-/Check-out-Zeit als UTC-ISO */
  startUtc: string;
  endUtc: string;
}

export type IncompleteReason = 'gap' | 'reset';
export type RowStatus = 'complete' | 'incomplete' | 'running';

export interface PowerRow {
  kind: 'stay' | 'vacancy';
  reservationId: string | null;
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  startUtc: string;
  endUtc: string;
  /** Buchung: Nächte laut Reservierung; Leerstand: null */
  nights: number | null;
  /** Dauer in Tagen (Ende − Beginn; laufend: bis zum letzten Zählerstand), 2 Nachkommastellen */
  days: number;
  status: RowStatus;
  incompleteReason: IncompleteReason | null;
  kwh: number | null;
  /** nur Buchungen */
  kwhPerNight: number | null;
  /** nur Leerstand */
  kwhPerDay: number | null;
  /** nur Buchungen: Abweichung kWh/Nacht vom Median in %, wenn ein Median existiert */
  deviationPct: number | null;
  flagged: boolean;
}

export interface PowerComputation {
  /** chronologisch aufsteigend: Buchung, Leerstand, Buchung, … */
  rows: PowerRow[];
  medianKwhPerNight: number | null;
  comparisonCount: number;
  flaggingActive: boolean;
}

interface Pt { t: number; kwh: number }

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toPoints(readings: ReadingPoint[]): Pt[] {
  return readings
    .map((r) => ({ t: Date.parse(r.measuredAt), kwh: r.kwh }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.kwh))
    .sort((a, b) => a.t - b.t);
}

function lastAtOrBefore(points: Pt[], t: number): number {
  let idx = -1;
  for (let i = 0; i < points.length && points[i].t <= t; i++) idx = i;
  return idx;
}

function firstAtOrAfter(points: Pt[], t: number): number {
  for (let i = 0; i < points.length; i++) if (points[i].t >= t) return i;
  return -1;
}

/**
 * Zählerstand zum Zeitpunkt `t` (ms). Exakter Treffer → dieser Stand; sonst lineare
 * Interpolation, wenn ein Stand davor und einer danach existieren und höchstens 3 h
 * auseinanderliegen; sonst null.
 */
export function readingAt(readings: ReadingPoint[], t: number): number | null {
  return valueAt(toPoints(readings), t);
}

function valueAt(points: Pt[], t: number): number | null {
  const b = lastAtOrBefore(points, t);
  if (b >= 0 && points[b].t === t) return points[b].kwh;
  const a = firstAtOrAfter(points, t);
  if (b < 0 || a < 0) return null;
  const before = points[b];
  const after = points[a];
  if (after.t - before.t > MAX_INTERPOLATION_GAP_MS) return null;
  return before.kwh + ((after.kwh - before.kwh) * (t - before.t)) / (after.t - before.t);
}

/** Sinkt der Stand zwischen zwei aufeinanderfolgenden Messungen im Bereich [from, to]? */
function hasDecrease(points: Pt[], from: number, to: number): boolean {
  const lo = Math.max(0, lastAtOrBefore(points, from));
  const hiIdx = firstAtOrAfter(points, to);
  const hi = hiIdx < 0 ? points.length - 1 : hiIdx;
  for (let i = lo + 1; i <= hi; i++) if (points[i].kwh < points[i - 1].kwh) return true;
  return false;
}

interface SpanResult {
  status: RowStatus;
  incompleteReason: IncompleteReason | null;
  kwh: number | null;
  /** tatsächlich ausgewertete Dauer in ms */
  spanMs: number;
}

/** Verbrauch über [start, end]; endet `end` nach `now`, wird bis zum letzten Stand gerechnet. */
function consumption(points: Pt[], start: number, end: number, now: number): SpanResult {
  const running = end > now;
  const startVal = valueAt(points, start);
  if (startVal === null) {
    return { status: 'incomplete', incompleteReason: 'gap', kwh: null, spanMs: (running ? now : end) - start };
  }
  let endT = end;
  let endVal: number | null;
  if (running) {
    const last = points[points.length - 1];
    if (!last || last.t <= start) {
      return { status: 'running', incompleteReason: null, kwh: null, spanMs: now - start };
    }
    endT = last.t;
    endVal = last.kwh;
  } else {
    endVal = valueAt(points, end);
  }
  if (endVal === null) return { status: 'incomplete', incompleteReason: 'gap', kwh: null, spanMs: end - start };
  if (endVal < startVal || hasDecrease(points, start, endT)) {
    return { status: 'incomplete', incompleteReason: 'reset', kwh: null, spanMs: endT - start };
  }
  return { status: running ? 'running' : 'complete', incompleteReason: null, kwh: endVal - startVal, spanMs: endT - start };
}

function perUnit(span: SpanResult, units: number | null): number | null {
  if (span.kwh === null || !units || units <= 0) return null;
  if (span.status === 'running' && span.spanMs < MIN_RUNNING_SPAN_MS) return null;
  return round(span.kwh / units, 2);
}

/**
 * Baut die Zeilen (Buchungen + Leerstand) und die Median-Auswertung.
 * `stays`: nur bestätigte Buchungen, beliebige Reihenfolge; `now`: ms.
 */
export function computePowerRows(stays: StayInput[], readings: ReadingPoint[], now: number): PowerComputation {
  const points = toPoints(readings);
  const sorted = [...stays].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  const rows: PowerRow[] = [];

  const vacancyRow = (start: number, end: number): PowerRow => {
    const span = consumption(points, start, end, now);
    const days = span.spanMs / DAY_MS;
    return {
      kind: 'vacancy', reservationId: null, guestName: null, checkInDate: null, checkOutDate: null,
      startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(),
      nights: null, days: round(days, 2), status: span.status, incompleteReason: span.incompleteReason,
      kwh: span.kwh === null ? null : round(span.kwh, 2), kwhPerNight: null, kwhPerDay: perUnit(span, days),
      deviationPct: null, flagged: false,
    };
  };

  sorted.forEach((s, i) => {
    const start = Date.parse(s.startUtc);
    const end = Date.parse(s.endUtc);
    if (start > now) return; // künftige Buchungen nicht auswerten
    const span = consumption(points, start, end, now);
    const running = span.status === 'running';
    const elapsedNights = running ? span.spanMs / DAY_MS : s.nights;
    rows.push({
      kind: 'stay', reservationId: s.reservationId, guestName: s.guestName,
      checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, startUtc: s.startUtc, endUtc: s.endUtc,
      nights: s.nights, days: round(span.spanMs / DAY_MS, 2), status: span.status,
      incompleteReason: span.incompleteReason, kwh: span.kwh === null ? null : round(span.kwh, 2),
      kwhPerNight: perUnit(span, elapsedNights), kwhPerDay: null, deviationPct: null, flagged: false,
    });
    if (end >= now) return;
    const next = sorted[i + 1];
    const nextStart = next ? Date.parse(next.startUtc) : Number.POSITIVE_INFINITY;
    if (nextStart <= end) return; // nahtloser/überlappender Wechsel: kein Leerstand
    // Leerstand bis zum nächsten Check-in; liegt der in der Zukunft, läuft der Leerstand noch.
    rows.push(vacancyRow(end, Number.isFinite(nextStart) ? nextStart : Math.max(now + 1, end + 1)));
  });

  const comparison = rows.filter((r) => r.kind === 'stay' && r.status === 'complete' && r.kwhPerNight !== null);
  const med = median(comparison.map((r) => r.kwhPerNight as number));
  const flaggingActive = comparison.length >= MIN_COMPARISON_STAYS;
  for (const r of rows) {
    if (r.kind !== 'stay' || r.kwhPerNight === null || med === null) continue;
    if (med > 0) r.deviationPct = round((r.kwhPerNight / med - 1) * 100, 0);
    r.flagged = flaggingActive && r.kwhPerNight > med * FLAG_THRESHOLD_FACTOR;
  }

  return { rows, medianKwhPerNight: med === null ? null : round(med, 2), comparisonCount: comparison.length, flaggingActive };
}
