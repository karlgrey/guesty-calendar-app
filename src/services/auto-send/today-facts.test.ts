// #698 (Fall Lorenzo U19, 20.09.2026): reine Funktionen für den HEUTE-Fakt im Entwurfs-/
// Judge-Prompt (draft-service.ts/judge-prompt.ts) und für den mechanischen Wochentags-Check
// (mechanical-checks.ts) — kein I/O, kein Modellaufruf.
import { describe, it, expect } from 'vitest';
import { parseBookingPeriod, buildTodayBlock, allowedWeekdays } from './today-facts.js';

describe('parseBookingPeriod', () => {
  it('parst "Zeitraum TT.MM.JJJJ–TT.MM.JJJJ" (Gedankenstrich) aus dem Buchungskontext-Prosa-String', () => {
    expect(parseBookingPeriod('Bestätigte Buchung (Status: confirmed): Zeitraum 02.08.2026–07.08.2026, 5 Nächte, 2 Personen, Konfirmationscode ABC.')).toEqual({
      checkIn: '2026-08-02',
      checkOut: '2026-08-07',
    });
  });
  it('tolerant auch mit einfachem Bindestrich "-"', () => {
    expect(parseBookingPeriod('Buchungsanfrage (noch nicht bestätigt): Zeitraum 29.01.2027-31.01.2027, 2 Nächte, 15 Personen — Daten stammen aus der Anfrage selbst.')).toEqual({
      checkIn: '2027-01-29',
      checkOut: '2027-01-31',
    });
  });
  it('null bei "?"-Datum', () => {
    expect(parseBookingPeriod('Buchung: Zeitraum ?–?, 3 Nächte, 2 Personen, Konfirmationscode X.')).toBeNull();
  });
  it('null ohne Zeitraum', () => {
    expect(parseBookingPeriod('Irgendein Text ohne Zeitraum.')).toBeNull();
  });
  it('null ohne bookingContext', () => {
    expect(parseBookingPeriod(null)).toBeNull();
  });
});

describe('buildTodayBlock', () => {
  it('enthält immer die HEUTE-Zeile', () => {
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), null);
    expect(block).toBe('HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)');
  });

  it('Anreise in N Tagen', () => {
    const bookingContext = 'Buchung: Zeitraum 28.09.2026–02.10.2026, 4 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)\n' +
      'Anreise in 3 Tagen (Montag, 28.09.2026); Abreise Freitag, 02.10.2026',
    );
  });

  it('Anreise HEUTE', () => {
    const bookingContext = 'Buchung: Zeitraum 25.09.2026–28.09.2026, 3 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)\n' +
      'Anreise HEUTE; Abreise Montag, 28.09.2026',
    );
  });

  it('Gast ist vor Ort (heute zwischen checkIn und checkOut, exklusiv)', () => {
    const bookingContext = 'Buchung: Zeitraum 22.09.2026–28.09.2026, 6 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)\n' +
      'Gast ist vor Ort; Abreise in 3 Tagen (Montag, 28.09.2026)',
    );
  });

  it('Abreise HEUTE', () => {
    const bookingContext = 'Buchung: Zeitraum 20.09.2026–25.09.2026, 5 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)\n' +
      'Abreise HEUTE',
    );
  });

  it('Abreise war vor N Tagen', () => {
    const bookingContext = 'Buchung: Zeitraum 15.09.2026–20.09.2026, 5 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)\n' +
      'Abreise war vor 5 Tagen (Sonntag, 20.09.2026)',
    );
  });

  it('kein Zeitraum parsebar ("?") → nur HEUTE-Zeile', () => {
    const bookingContext = 'Buchung: Zeitraum ?–?, 3 Nächte, 2 Personen, Konfirmationscode X.';
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), bookingContext);
    expect(block).toBe('HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)');
  });

  it('ohne bookingContext → nur HEUTE-Zeile', () => {
    const block = buildTodayBlock(new Date('2026-09-25T06:45:00.000Z'), null);
    expect(block).toBe('HEUTE: Freitag, 25.09.2026, 08:45 Uhr (Europe/Berlin)');
  });

  it('Zeitzone/DST-Grenze: kurz vor Mitternacht UTC gehört zum nächsten Berliner Tag', () => {
    const bookingContext = 'Buchung: Zeitraum 20.09.2026–21.09.2026, 1 Nacht, 2 Personen, Konfirmationscode X.';
    // 2026-09-19T22:30Z = 2026-09-20T00:30 Berlin → HEUTE ist bereits der 20.09. (checkIn).
    const block = buildTodayBlock(new Date('2026-09-19T22:30:00.000Z'), bookingContext);
    expect(block).toBe(
      'HEUTE: Sonntag, 20.09.2026, 00:30 Uhr (Europe/Berlin)\n' +
      'Anreise HEUTE; Abreise Montag, 21.09.2026',
    );
  });
});

describe('allowedWeekdays', () => {
  it('ohne bookingContext: nur der heutige Wochentag', () => {
    // 2026-09-25 ist ein Freitag (Index 5).
    expect(allowedWeekdays(new Date('2026-09-25T06:45:00.000Z'), null)).toEqual(new Set([5]));
  });

  it('heute ∪ alle Aufenthaltstage (Fr–So inklusive), auch wenn heute außerhalb liegt', () => {
    // heute: Montag 2026-09-21 (Index 1). Aufenthalt Fr 2026-09-25 – So 2026-09-27 (Index 5,6,0).
    const bookingContext = 'Buchung: Zeitraum 25.09.2026–27.09.2026, 2 Nächte, 2 Personen, Konfirmationscode X.';
    expect(allowedWeekdays(new Date('2026-09-21T09:00:00.000Z'), bookingContext)).toEqual(new Set([1, 5, 6, 0]));
  });

  it('Aufenthalt ≥ 7 Tage → alle Wochentage erlaubt', () => {
    const bookingContext = 'Buchung: Zeitraum 01.09.2026–15.09.2026, 14 Nächte, 2 Personen, Konfirmationscode X.';
    expect(allowedWeekdays(new Date('2026-09-25T06:45:00.000Z'), bookingContext)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
  });

  it('"?"-Datum → nur der heutige Wochentag', () => {
    const bookingContext = 'Buchung: Zeitraum ?–?, 3 Nächte, 2 Personen, Konfirmationscode X.';
    expect(allowedWeekdays(new Date('2026-09-25T06:45:00.000Z'), bookingContext)).toEqual(new Set([5]));
  });
});
