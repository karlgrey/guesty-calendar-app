import { describe, it, expect } from 'vitest';
import { dayInTimezone, isPropertyInReporting, filterPropertiesInReporting } from './reporting-scope.js';

// #1223: Florenz-Stichtag reportingUntil "2026-11-23"
describe('reporting-scope', () => {
  const florenz = { slug: 'firenze-loft', reportingUntil: '2026-11-23' };
  const farmhouse = { slug: 'farmhouse' };

  it('Mo 23.11. 06:00 Berlin: noch drin', () => {
    expect(isPropertyInReporting(florenz, new Date('2026-11-23T05:00:00Z'))).toBe(true);
  });

  it('23.11. 23:30 Berlin (22:30 UTC): noch drin', () => {
    expect(isPropertyInReporting(florenz, new Date('2026-11-23T22:30:00Z'))).toBe(true);
  });

  it('24.11. 00:30 Berlin (23:30 UTC am 23.): raus', () => {
    expect(isPropertyInReporting(florenz, new Date('2026-11-23T23:30:00Z'))).toBe(false);
  });

  it('Mo 30.11. 06:00 Berlin: raus', () => {
    expect(isPropertyInReporting(florenz, new Date('2026-11-30T05:00:00Z'))).toBe(false);
  });

  it('ohne reportingUntil immer drin', () => {
    expect(isPropertyInReporting(farmhouse, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });

  it('filterPropertiesInReporting', () => {
    const now = new Date('2026-11-24T05:00:00Z');
    expect(filterPropertiesInReporting([farmhouse, florenz], now)).toEqual([farmhouse]);
  });

  it('dayInTimezone rechnet in Berlin', () => {
    expect(dayInTimezone(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
  });
});
