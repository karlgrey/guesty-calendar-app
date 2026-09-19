import { describe, it, expect } from 'vitest';
import { startOfBerlinDayIso } from './berlin-day.js';

describe('startOfBerlinDayIso', () => {
  it('Sommerzeit: 00:00 Berlin = 22:00Z Vortag', () => {
    expect(startOfBerlinDayIso(new Date('2026-09-19T10:30:00.000Z'))).toBe('2026-09-18T22:00:00.000Z');
  });
  it('Winterzeit: 00:00 Berlin = 23:00Z Vortag', () => {
    expect(startOfBerlinDayIso(new Date('2026-12-05T10:30:00.000Z'))).toBe('2026-12-04T23:00:00.000Z');
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten Berliner Tag', () => {
    expect(startOfBerlinDayIso(new Date('2026-09-19T22:30:00.000Z'))).toBe('2026-09-19T22:00:00.000Z');
  });
});
