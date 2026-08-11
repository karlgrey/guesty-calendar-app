import { describe, it, expect } from 'vitest';
import { addOneDay, nightsBetween } from './date.js';

describe('addOneDay', () => {
  it('adds one day within a month', () => {
    expect(addOneDay('2026-08-10')).toBe('2026-08-11');
  });

  it('rolls over a month boundary', () => {
    expect(addOneDay('2026-08-31')).toBe('2026-09-01');
  });

  it('rolls over a year boundary', () => {
    expect(addOneDay('2026-12-31')).toBe('2027-01-01');
  });

  it('handles Feb 28 in a non-leap year', () => {
    expect(addOneDay('2026-02-28')).toBe('2026-03-01');
  });

  it('handles Feb 28 in a leap year', () => {
    expect(addOneDay('2024-02-28')).toBe('2024-02-29');
  });
});

describe('nightsBetween', () => {
  it('counts nights for a multi-night stay', () => {
    expect(nightsBetween('2026-08-10', '2026-08-15')).toBe(5);
  });

  it('returns 1 for a single-night stay', () => {
    expect(nightsBetween('2026-08-10', '2026-08-11')).toBe(1);
  });

  it('returns 0 for identical start and endExclusive', () => {
    expect(nightsBetween('2026-08-10', '2026-08-10')).toBe(0);
  });

  it('counts correctly across a month boundary', () => {
    expect(nightsBetween('2026-08-30', '2026-09-02')).toBe(3);
  });
});
