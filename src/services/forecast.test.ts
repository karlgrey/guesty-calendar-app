import { describe, it, expect } from 'vitest';
import { buildLeadTimeCurve, shareOnBooksAt, forecastMonthRevenue } from './forecast.js';

const richCurve = buildLeadTimeCurve(
  Array.from({ length: 40 }, (_, i) => ({ checkIn: '2026-03-01', reservedAt: `2026-0${i % 2 === 0 ? '1' : '2'}-01` }))
);

function base(overrides = {}) {
  return {
    monthLabel: 'Jul',
    committedRevenue: 5000,
    daysUntilMidpoint: 40,
    daysInMonth: 31,
    monthsSinceStart: 24,        // mature by default
    priorYearRevenue: null,
    priorYearsAvailable: 0,
    growth: 1.0,
    adr: 150,
    rampMonths: 12,
    steadyOccupancyPct: 0.6,
    curve: richCurve,
    propertySampleN: 40,
    ...overrides,
  };
}

describe('buildLeadTimeCurve / shareOnBooksAt', () => {
  it('counts leadDays >= d, floored at 0.05', () => {
    const c = buildLeadTimeCurve([
      { checkIn: '2026-02-01', reservedAt: '2026-01-02' }, // 30
      { checkIn: '2026-02-01', reservedAt: '2026-01-22' }, // 10
    ]);
    expect(shareOnBooksAt(c, 0)).toBeCloseTo(1.0);
    expect(shareOnBooksAt(c, 20)).toBeCloseTo(0.5);
    expect(shareOnBooksAt(c, 999)).toBeCloseTo(0.05);
  });
});

describe('forecastMonthRevenue — method selection', () => {
  it('historical: uses prior-year revenue x growth, method historical', () => {
    const f = forecastMonthRevenue(base({ priorYearRevenue: 10000, priorYearsAvailable: 1, committedRevenue: 3000, growth: 1.1 }));
    expect(f.method).toBe('historical');
    expect(f.expectedRevenue).toBe(11000); // 10000 * 1.1, > committed
    expect(f.confidence).toBe('mittel');   // 1 prior year
  });

  it('historical with >=2 prior years -> confidence hoch and tighter range', () => {
    const f = forecastMonthRevenue(base({ priorYearRevenue: 8000, priorYearsAvailable: 2, committedRevenue: 0 }));
    expect(f.method).toBe('historical');
    expect(f.confidence).toBe('hoch');
    // spread 0.12 -> high = 8000*1.12 = 8960
    expect(f.highRevenue).toBe(8960);
  });

  it('pickup fallback: committed / share when no prior year', () => {
    // near month, rich curve -> mittel confidence
    const f = forecastMonthRevenue(base({ priorYearRevenue: null, committedRevenue: 4000, daysUntilMidpoint: 0 }));
    expect(f.method).toBe('pickup');
    expect(f.expectedRevenue).toBe(4000); // share ~1 at d=0
    expect(f.confidence).toBe('mittel');
  });

  it('pickup far horizon -> niedrig confidence, expected >= committed', () => {
    const f = forecastMonthRevenue(base({ priorYearRevenue: null, committedRevenue: 1000, daysUntilMidpoint: 999 }));
    expect(f.method).toBe('pickup');
    expect(f.expectedRevenue).toBeGreaterThan(1000);
    expect(f.confidence).toBe('niedrig');
  });

  it('ramp-up floor for a new listing lifts a near-zero far month', () => {
    // new listing (3 months old), far month, nothing booked, no history
    const f = forecastMonthRevenue(base({
      priorYearRevenue: null, committedRevenue: 0, daysUntilMidpoint: 999,
      monthsSinceStart: 3, adr: 100, daysInMonth: 30, rampMonths: 12, steadyOccupancyPct: 0.6,
      curve: buildLeadTimeCurve([]), propertySampleN: 4,
    }));
    // rampBaseline = (3/12) * 0.6 * 30 * 100 = 450
    expect(f.method).toBe('rampup');
    expect(f.expectedRevenue).toBe(450);
    expect(f.confidence).toBe('niedrig');
    expect(f.isOpen).toBe(false);
  });

  it('noch offen: no committed, no history, no ramp basis -> isOpen', () => {
    const f = forecastMonthRevenue(base({
      priorYearRevenue: null, committedRevenue: 0, monthsSinceStart: null,
      curve: buildLeadTimeCurve([]),
    }));
    expect(f.isOpen).toBe(true);
    expect(f.confidence).toBe('niedrig');
  });

  it('range never goes below committed and brackets expected', () => {
    const f = forecastMonthRevenue(base({ priorYearRevenue: 9000, priorYearsAvailable: 1, committedRevenue: 2000 }));
    expect(f.lowRevenue).toBeGreaterThanOrEqual(2000);
    expect(f.lowRevenue).toBeLessThanOrEqual(f.expectedRevenue);
    expect(f.highRevenue).toBeGreaterThanOrEqual(f.expectedRevenue);
  });
});
