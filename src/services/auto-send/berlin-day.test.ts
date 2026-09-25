import { describe, it, expect } from 'vitest';
import { startOfBerlinDayIso, nextBerlinBusinessDay, formatBerlinDeadline, berlinCalendarDay, berlinWeekdayIndex, formatBerlinToday, WEEKDAY_DE_LONG } from './berlin-day.js';

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

// #697: Buchungsanfrage-Frist (Fall Anika, System-Post 2026-09-21T20:35:04Z + 24h = 2026-09-22T20:35:04Z)
describe('formatBerlinDeadline (#697, Buchungsanfrage-Frist)', () => {
  it('Sommerzeit: Dienstag 20:35Z = Di 22:35 Berlin', () => {
    expect(formatBerlinDeadline('2026-09-22T20:35:04.000Z')).toBe('Di 22:35');
  });
  it('Winterzeit: kein DST-Offset mehr', () => {
    expect(formatBerlinDeadline('2026-12-05T10:00:00.000Z')).toBe('Sa 11:00');
  });
  it('Wochenende bleibt Wochenende (keine Werktags-Verschiebung)', () => {
    expect(formatBerlinDeadline('2026-09-20T09:00:00.000Z')).toBe('So 11:00');
  });
});

describe('berlinCalendarDay (#697, SmartTasks-dueDate, auch am Wochenende)', () => {
  it('Sommerzeit', () => {
    expect(berlinCalendarDay('2026-09-22T20:35:04.000Z')).toBe('2026-09-22');
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten Berliner Kalendertag', () => {
    expect(berlinCalendarDay('2026-09-19T22:30:00.000Z')).toBe('2026-09-20');
  });
  it('Samstag bleibt Samstag — bewusst keine Werktags-Regel', () => {
    expect(berlinCalendarDay('2026-09-19T10:00:00.000Z')).toBe('2026-09-19');
  });
});

// #698 (Fall Lorenzo U19, 20.09.2026): HEUTE-Fakt für Entwurfs-/Judge-Prompt — der Entwurfs-
// Systemprompt kannte bisher weder Wochentag noch Uhrzeit, deshalb spiegelte ein Entwurf
// sonntags gepostete Zeitbezüge ("have a wonderful Sunday"), obwohl der Versand erst montags
// erfolgte.
describe('berlinWeekdayIndex (#698)', () => {
  it('0=So … 6=Sa des Berliner Kalendertags', () => {
    // 2026-09-19 ist ein Samstag (siehe nextBerlinBusinessDay-Tests oben).
    expect(berlinWeekdayIndex(new Date('2026-09-19T10:00:00.000Z'))).toBe(6);
    // 2026-09-20 ist ein Sonntag.
    expect(berlinWeekdayIndex(new Date('2026-09-20T10:00:00.000Z'))).toBe(0);
    // 2026-09-21 ist ein Montag.
    expect(berlinWeekdayIndex(new Date('2026-09-21T10:00:00.000Z'))).toBe(1);
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten Berliner Kalendertag', () => {
    // 2026-09-19T22:30Z = 2026-09-20T00:30 Berlin (Sommerzeit) = Sonntag.
    expect(berlinWeekdayIndex(new Date('2026-09-19T22:30:00.000Z'))).toBe(0);
  });
});

describe('WEEKDAY_DE_LONG (#698)', () => {
  it('sieben lange deutsche Wochentagsnamen, beginnend mit Sonntag', () => {
    expect(WEEKDAY_DE_LONG).toEqual(['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']);
  });
});

describe('formatBerlinToday (#698, Fall Lorenzo)', () => {
  it('Sommerzeit: 2026-09-19T10:30Z → Samstag, 19.09.2026, 12:30 Uhr', () => {
    expect(formatBerlinToday(new Date('2026-09-19T10:30:00.000Z'))).toBe('Samstag, 19.09.2026, 12:30 Uhr (Europe/Berlin)');
  });
  it('Winterzeit: 2026-12-05T10:30Z → Samstag, 05.12.2026, 11:30 Uhr', () => {
    expect(formatBerlinToday(new Date('2026-12-05T10:30:00.000Z'))).toBe('Samstag, 05.12.2026, 11:30 Uhr (Europe/Berlin)');
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten Berliner Tag', () => {
    expect(formatBerlinToday(new Date('2026-09-19T22:30:00.000Z'))).toBe('Sonntag, 20.09.2026, 00:30 Uhr (Europe/Berlin)');
  });
  it('Umstellungstag Frühjahr: Mitternacht galt noch mit altem Offset (+1h)', () => {
    expect(formatBerlinToday(new Date('2026-03-29T12:00:00.000Z'))).toBe('Sonntag, 29.03.2026, 14:00 Uhr (Europe/Berlin)');
  });
  it('Umstellungstag Herbst: neuer Offset (+1h)', () => {
    expect(formatBerlinToday(new Date('2026-10-25T12:00:00.000Z'))).toBe('Sonntag, 25.10.2026, 13:00 Uhr (Europe/Berlin)');
  });
  it('Fall Lorenzo: Montag 2026-09-21T09:00Z', () => {
    expect(formatBerlinToday(new Date('2026-09-21T09:00:00.000Z'))).toBe('Montag, 21.09.2026, 11:00 Uhr (Europe/Berlin)');
  });
});
