import { describe, it, expect } from 'vitest';
import { buildLeadTimeCurve, shareOnBooksAt, forecastMonth } from './forecast.js';

describe('buildLeadTimeCurve', () => {
  it('computes lead days (>=0) and sample count', () => {
    const curve = buildLeadTimeCurve([
      { checkIn: '2026-07-11', reservedAt: '2026-07-01' }, // 10
      { checkIn: '2026-07-01', reservedAt: '2026-07-01' }, // 0
      { checkIn: '2026-06-01', reservedAt: '2026-07-01' }, // negative -> clamped to 0
    ]);
    expect(curve.n).toBe(3);
    expect(curve.leadDays).toEqual([10, 0, 0]);
  });
});

describe('shareOnBooksAt', () => {
  const curve = buildLeadTimeCurve([
    { checkIn: '2026-02-01', reservedAt: '2026-01-02' }, // 30
    { checkIn: '2026-02-01', reservedAt: '2026-01-12' }, // 20
    { checkIn: '2026-02-01', reservedAt: '2026-01-22' }, // 10
    { checkIn: '2026-02-01', reservedAt: '2026-02-01' }, // 0
  ]);
  it('is 1.0 at d=0', () => expect(shareOnBooksAt(curve, 0)).toBeCloseTo(1.0));
  it('counts leadDays >= d', () => {
    // d=15 -> leads 30,20 qualify -> 2/4 = 0.5
    expect(shareOnBooksAt(curve, 15)).toBeCloseTo(0.5);
  });
  it('floors at 0.05 for far horizons', () => {
    expect(shareOnBooksAt(curve, 999)).toBeCloseTo(0.05);
  });
});

describe('forecastMonth', () => {
  const curve = buildLeadTimeCurve(
    Array.from({ length: 40 }, (_, i) => ({
      checkIn: '2026-03-01',
      reservedAt: `2026-0${i % 2 === 0 ? '1' : '2'}-01`, // mix of ~59 and ~28 day leads
    }))
  );
  it('near month: high share -> projected ~= committed, small band', () => {
    const f = forecastMonth({
      monthLabel: 'Jun', otbNights: 20, capacityNights: 30,
      otbRevenue: 4000, daysUntilMidpoint: 0, curve, propertySampleN: 40,
    });
    expect(f.committedPct).toBe(67);
    expect(f.projectedFinalPct).toBe(67);
    expect(f.bandPct).toBe(0);
    expect(f.projectedRevenue).toBe(4000);
    expect(f.lowData).toBe(false);
  });
  it('far month: low share -> projected > committed, wide band, capped at 100', () => {
    const f = forecastMonth({
      monthLabel: 'Nov', otbNights: 6, capacityNights: 30,
      otbRevenue: 1200, daysUntilMidpoint: 999, curve, propertySampleN: 40,
    });
    expect(f.committedPct).toBe(20);
    expect(f.projectedFinalPct).toBe(100); // 20 / 0.05 = 400 -> capped
    expect(f.bandPct).toBeGreaterThan(20);
    expect(f.projectedRevenue).toBe(24000); // 1200 / 0.05
  });
  it('flags low data when property sample is small', () => {
    const f = forecastMonth({
      monthLabel: 'Aug', otbNights: 10, capacityNights: 30,
      otbRevenue: 2000, daysUntilMidpoint: 30, curve, propertySampleN: 5,
    });
    expect(f.lowData).toBe(true);
  });
});
