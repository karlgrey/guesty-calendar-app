/**
 * Forecast (pure functions) — revenue outlook with a layered method:
 * historical (prior-year x growth) > lead-time pickup > ramp-up floor.
 *
 * No Date usage: callers pass daysUntilMidpoint / monthsSinceStart / daysInMonth
 * so the math stays deterministic and unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHARE_FLOOR = 0.05;

export type ForecastMethod = 'historical' | 'pickup' | 'rampup';
export type ForecastConfidence = 'hoch' | 'mittel' | 'niedrig';

export interface LeadTimeCurve {
  leadDays: number[];
  n: number;
}

export interface RevenueForecast {
  monthLabel: string;
  committedRevenue: number;
  expectedRevenue: number;
  lowRevenue: number;
  highRevenue: number;
  confidence: ForecastConfidence;
  method: ForecastMethod;
  isOpen: boolean; // "noch offen" — no basis for an estimate
}

export interface RevenueForecastInput {
  monthLabel: string;
  committedRevenue: number;
  daysUntilMidpoint: number;
  daysInMonth: number;
  monthsSinceStart: number | null; // null = unknown/mature (not a new listing)
  priorYearRevenue: number | null; // null = no prior-year occurrence
  priorYearsAvailable: number;     // 0,1,2...
  growth: number;                  // default 1.0
  adr: number;
  rampMonths: number;
  steadyOccupancyPct: number;
  curve: LeadTimeCurve;
  propertySampleN: number;
}

/** Build a pooled lead-time curve from booking samples. */
export function buildLeadTimeCurve(
  samples: Array<{ checkIn: string; reservedAt: string }>
): LeadTimeCurve {
  const leadDays = samples.map((s) => {
    const diff = (new Date(s.checkIn).getTime() - new Date(s.reservedAt).getTime()) / MS_PER_DAY;
    return Math.max(0, Math.floor(diff));
  });
  return { leadDays, n: leadDays.length };
}

/** Fraction of final bookings already on the books `d` days before check-in. */
export function shareOnBooksAt(curve: LeadTimeCurve, daysBefore: number): number {
  if (curve.n === 0) return 1;
  const qualifying = curve.leadDays.filter((l) => l >= daysBefore).length;
  return Math.max(SHARE_FLOOR, qualifying / curve.n);
}

/** Project one month's revenue (committed/expected/low/high) + confidence + method. */
export function forecastMonthRevenue(input: RevenueForecastInput): RevenueForecast {
  const {
    monthLabel, committedRevenue, daysUntilMidpoint, daysInMonth, monthsSinceStart,
    priorYearRevenue, priorYearsAvailable, growth, adr, rampMonths, steadyOccupancyPct,
    curve, propertySampleN: _propertySampleN,
  } = input;

  const share = shareOnBooksAt(curve, Math.max(0, daysUntilMidpoint));

  // 1. base from best available method.
  // A zero prior-year month carries no signal (off-season / no bookings) — fall
  // back to pickup rather than labelling it "Vorjahr" with a collapsed range.
  let method: ForecastMethod;
  let base: number;
  if (priorYearRevenue !== null && priorYearRevenue > 0) {
    method = 'historical';
    base = priorYearRevenue * growth;
  } else {
    method = 'pickup';
    base = share > 0 ? committedRevenue / share : committedRevenue;
  }

  // 2. ramp-up floor for new listings
  const isNew = monthsSinceStart !== null && monthsSinceStart < rampMonths;
  if (isNew) {
    const rampFactor = Math.min(1, Math.max(0, (monthsSinceStart as number) / rampMonths));
    const rampBaseline = rampFactor * steadyOccupancyPct * daysInMonth * adr;
    if (rampBaseline > base) {
      base = rampBaseline;
      method = 'rampup';
    }
  }

  const expected = Math.max(committedRevenue, base);
  const isOpen = expected < 1;

  // 3. spread by method/data depth
  let spread: number;
  if (method === 'historical') spread = priorYearsAvailable >= 2 ? 0.12 : 0.2;
  else if (method === 'pickup') spread = 0.3;
  else spread = 0.4;

  const low = Math.max(committedRevenue, base * (1 - spread));
  const high = Math.max(expected, base * (1 + spread));

  // 4. confidence
  let confidence: ForecastConfidence;
  if (isOpen) confidence = 'niedrig';
  else if (method === 'historical') confidence = priorYearsAvailable >= 2 ? 'hoch' : 'mittel';
  else if (method === 'rampup') confidence = 'niedrig';
  else confidence = share >= 0.5 && curve.n >= 20 ? 'mittel' : 'niedrig';

  return {
    monthLabel,
    committedRevenue: Math.round(committedRevenue),
    expectedRevenue: Math.round(expected),
    lowRevenue: Math.round(low),
    highRevenue: Math.round(high),
    confidence,
    method,
    isOpen,
  };
}
