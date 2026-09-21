import { describe, it, expect } from 'vitest';
import { startOfBerlinDayIso, nextBerlinBusinessDay } from './berlin-day.js';

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
  it('Frühjahrs-Umstellung: Mitternacht galt noch mit altem Offset (+1h)', () => {
    expect(startOfBerlinDayIso(new Date('2026-03-29T12:00:00.000Z'))).toBe('2026-03-28T23:00:00.000Z');
  });
  it('Herbst-Umstellung: Tag danach mit neuem Offset (+1h)', () => {
    expect(startOfBerlinDayIso(new Date('2026-10-25T12:00:00.000Z'))).toBe('2026-10-24T22:00:00.000Z');
  });
});

describe('nextBerlinBusinessDay (#696, Zusagen-Task-Fälligkeit)', () => {
  it('Montag → Dienstag', () => {
    expect(nextBerlinBusinessDay(new Date('2026-09-21T10:00:00.000Z'))).toBe('2026-09-22');
  });
  it('Freitag → Montag (überspringt Wochenende)', () => {
    expect(nextBerlinBusinessDay(new Date('2026-09-18T10:00:00.000Z'))).toBe('2026-09-21');
  });
  it('Samstag → Montag', () => {
    expect(nextBerlinBusinessDay(new Date('2026-09-19T10:00:00.000Z'))).toBe('2026-09-21');
  });
  it('Sonntag → Montag', () => {
    expect(nextBerlinBusinessDay(new Date('2026-09-20T10:00:00.000Z'))).toBe('2026-09-21');
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten (Sonntag-)Berliner Tag → Montag', () => {
    expect(nextBerlinBusinessDay(new Date('2026-09-19T22:30:00.000Z'))).toBe('2026-09-21');
  });
});
