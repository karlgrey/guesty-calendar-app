/**
 * Forecast (pure functions) — "on the books" + pickup projection.
 *
 * No Date usage in forecastMonth: callers pass `daysUntilMidpoint` for each
 * month so the math stays deterministic and unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHARE_FLOOR = 0.05;

export interface LeadTimeCurve {
  leadDays: number[];
  n: number;
}

export interface MonthForecast {
  monthLabel: string;
  committedPct: number;
  projectedFinalPct: number;
  bandPct: number;
  committedRevenue: number;
  projectedRevenue: number;
  lowData: boolean;
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
  if (curve.n === 0) return 1; // no history -> assume fully booked (committed only)
  const qualifying = curve.leadDays.filter((l) => l >= daysBefore).length;
  return Math.max(SHARE_FLOOR, qualifying / curve.n);
}

export interface ForecastMonthInput {
  monthLabel: string;
  otbNights: number;
  capacityNights: number;
  otbRevenue: number;
  daysUntilMidpoint: number;
  curve: LeadTimeCurve;
  propertySampleN: number;
}

/** Project a single month's final occupancy + revenue from OTB and the curve. */
export function forecastMonth(input: ForecastMonthInput): MonthForecast {
  const { monthLabel, otbNights, capacityNights, otbRevenue, daysUntilMidpoint, curve, propertySampleN } = input;
  const share = shareOnBooksAt(curve, Math.max(0, daysUntilMidpoint));
  const committedPct = capacityNights > 0 ? Math.round((otbNights / capacityNights) * 100) : 0;
  const projectedFinalPct = Math.min(100, Math.round(committedPct / share));
  const lowData = propertySampleN < 15 || curve.n < 20;
  const bandPct = Math.min(40, Math.round((1 - share) * 35) + (lowData ? 8 : 0));
  return {
    monthLabel,
    committedPct,
    projectedFinalPct,
    bandPct,
    committedRevenue: Math.round(otbRevenue),
    projectedRevenue: Math.round(otbRevenue / share),
    lowData,
  };
}
