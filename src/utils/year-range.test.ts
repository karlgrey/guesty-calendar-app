import { describe, it, expect } from 'vitest';
import { getYearRange } from './year-range.js';

describe('getYearRange', () => {
  it('returns Jan 1 start and exclusive next-year start', () => {
    expect(getYearRange(2026)).toEqual({
      start: '2026-01-01',
      endExclusive: '2027-01-01',
    });
  });

  it('endExclusive lets a Dec-31 check_in with time suffix still match a < comparison', () => {
    const { endExclusive } = getYearRange(2026);
    expect('2026-12-31T08:00:00+00:00' < endExclusive).toBe(true);
    expect('2027-01-01T00:00:00+00:00' < endExclusive).toBe(false);
  });
});
