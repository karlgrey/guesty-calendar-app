import { describe, it, expect } from 'vitest';
import { overlapsWindow, diffCalendarEvents, type ExpectedEvent, type GoogleEventLite } from './calendar-consistency.js';

describe('overlapsWindow', () => {
  it('event fully inside the window overlaps', () => {
    expect(overlapsWindow('2026-09-05', '2026-09-08', '2026-09-01', '2026-09-29')).toBe(true);
  });

  it('event ragt vorne ins Fenster hinein (startet davor, endet drin)', () => {
    expect(overlapsWindow('2026-08-25', '2026-09-03', '2026-09-01', '2026-09-29')).toBe(true);
  });

  it('event ragt hinten aus dem Fenster hinaus (startet drin, endet danach)', () => {
    expect(overlapsWindow('2026-09-27', '2026-10-05', '2026-09-01', '2026-09-29')).toBe(true);
  });

  it('event komplett außerhalb (davor) überlappt nicht', () => {
    expect(overlapsWindow('2026-08-01', '2026-08-10', '2026-09-01', '2026-09-29')).toBe(false);
  });

  it('event komplett außerhalb (danach) überlappt nicht', () => {
    expect(overlapsWindow('2026-10-01', '2026-10-10', '2026-09-01', '2026-09-29')).toBe(false);
  });

  it('event endet exakt am Fensterstart (exklusiv) überlappt nicht', () => {
    expect(overlapsWindow('2026-08-20', '2026-09-01', '2026-09-01', '2026-09-29')).toBe(false);
  });

  it('event startet exakt am Fensterende (exklusiv) überlappt nicht', () => {
    expect(overlapsWindow('2026-09-29', '2026-10-02', '2026-09-01', '2026-09-29')).toBe(false);
  });
});

function reservation(overrides: Partial<ExpectedEvent> = {}): ExpectedEvent {
  return {
    type: 'reservation',
    eventId: 'ev-res-1',
    reservationId: 'res-1',
    guestName: 'Louisa Strasser',
    status: 'confirmed',
    start: '2026-10-04',
    endExclusive: '2026-10-07',
    ...overrides,
  };
}

function block(overrides: Partial<ExpectedEvent> = {}): ExpectedEvent {
  return {
    type: 'block',
    eventId: 'ev-block-1',
    start: '2026-09-12',
    endExclusive: '2026-09-14',
    ...overrides,
  };
}

function googleAllDay(id: string, start: string, end: string, overrides: Partial<GoogleEventLite> = {}): GoogleEventLite {
  return { id, summary: 'Some Event', start: { date: start }, end: { date: end }, ...overrides };
}

describe('diffCalendarEvents', () => {
  it('ok-Fall: erwartetes Event exakt im Kalender -> keine Diffs', () => {
    const expected = [reservation()];
    const actual = [googleAllDay('ev-res-1', '2026-10-04', '2026-10-07')];
    const diff = diffCalendarEvents(expected, actual);
    expect(diff).toEqual({ missing: [], extra: [], mismatched: [] });
  });

  it('missing: erwartete Reservierung fehlt im Kalender', () => {
    const expected = [reservation()];
    const diff = diffCalendarEvents(expected, []);
    expect(diff.missing).toEqual([reservation()]);
    expect(diff.extra).toEqual([]);
    expect(diff.mismatched).toEqual([]);
  });

  it('missing: erwarteter Block fehlt im Kalender', () => {
    const expected = [block()];
    const diff = diffCalendarEvents(expected, []);
    expect(diff.missing).toEqual([block()]);
  });

  it('extra: manuell im Google-Kalender angelegtes Ganztages-Event', () => {
    const actual = [googleAllDay('manual-1', '2026-09-01', '2026-09-02', { summary: 'Handwerker vor Ort' })];
    const diff = diffCalendarEvents([], actual);
    expect(diff.extra).toEqual([
      { googleEventId: 'manual-1', summary: 'Handwerker vor Ort', start: '2026-09-01', end: '2026-09-02', isOwnerBlockEvent: false },
    ]);
  });

  it('extra: dateTime-Event (kein Ganztages-Event) landet immer in extra', () => {
    const actual: GoogleEventLite[] = [
      {
        id: 'timed-1',
        summary: 'Meeting',
        start: { dateTime: '2026-09-05T10:00:00+02:00' },
        end: { dateTime: '2026-09-05T11:00:00+02:00' },
      },
    ];
    const diff = diffCalendarEvents([], actual);
    expect(diff.extra).toEqual([
      { googleEventId: 'timed-1', summary: 'Meeting', start: '2026-09-05', end: '2026-09-05', isOwnerBlockEvent: false },
    ]);
  });

  it('extra: verwaistes App-Block-Event (kind=owner-block) trägt isOwnerBlockEvent=true', () => {
    const actual = [
      googleAllDay('ev-block-1', '2026-09-12', '2026-09-14', {
        summary: 'Owner-Block',
        extendedProperties: { private: { kind: 'owner-block' } },
      }),
    ];
    const diff = diffCalendarEvents([], actual);
    expect(diff.extra).toEqual([
      { googleEventId: 'ev-block-1', summary: 'Owner-Block', start: '2026-09-12', end: '2026-09-14', isOwnerBlockEvent: true },
    ]);
  });

  it('mismatched: Enddatum weicht ab', () => {
    const expected = [reservation({ eventId: 'ev-mis', start: '2026-09-12', endExclusive: '2026-09-14' })];
    const actual = [googleAllDay('ev-mis', '2026-09-12', '2026-09-15')];
    const diff = diffCalendarEvents(expected, actual);
    expect(diff.mismatched).toEqual([
      {
        eventId: 'ev-mis',
        summary: 'Some Event',
        expected: { start: '2026-09-12', endExclusive: '2026-09-14' },
        actual: { start: '2026-09-12', endExclusive: '2026-09-15' },
      },
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('mismatched: Startdatum weicht ab', () => {
    const expected = [reservation({ eventId: 'ev-mis2', start: '2026-09-12', endExclusive: '2026-09-14' })];
    const actual = [googleAllDay('ev-mis2', '2026-09-11', '2026-09-14')];
    const diff = diffCalendarEvents(expected, actual);
    expect(diff.mismatched).toHaveLength(1);
    expect(diff.mismatched[0].actual).toEqual({ start: '2026-09-11', endExclusive: '2026-09-14' });
  });

  it('dedupe: doppelte erwartete IDs — letzter gewinnt', () => {
    const expected = [
      reservation({ eventId: 'dup-1', start: '2026-09-01', endExclusive: '2026-09-03' }),
      reservation({ eventId: 'dup-1', start: '2026-09-05', endExclusive: '2026-09-08' }),
    ];
    const diff = diffCalendarEvents(expected, []);
    expect(diff.missing).toEqual([
      reservation({ eventId: 'dup-1', start: '2026-09-05', endExclusive: '2026-09-08' }),
    ]);
  });

  it('gemischter Fall: missing + extra + mismatched + ok gleichzeitig', () => {
    const expected = [
      reservation({ eventId: 'ok-1', start: '2026-09-01', endExclusive: '2026-09-03' }),
      reservation({ eventId: 'missing-1', start: '2026-10-04', endExclusive: '2026-10-07' }),
      block({ eventId: 'mismatch-1', start: '2026-09-12', endExclusive: '2026-09-14' }),
    ];
    const actual = [
      googleAllDay('ok-1', '2026-09-01', '2026-09-03'),
      googleAllDay('mismatch-1', '2026-09-12', '2026-09-15'),
      googleAllDay('extra-1', '2026-09-20', '2026-09-21', { summary: 'Manuell' }),
    ];
    const diff = diffCalendarEvents(expected, actual);
    expect(diff.missing).toEqual([reservation({ eventId: 'missing-1', start: '2026-10-04', endExclusive: '2026-10-07' })]);
    expect(diff.extra).toEqual([
      { googleEventId: 'extra-1', summary: 'Manuell', start: '2026-09-20', end: '2026-09-21', isOwnerBlockEvent: false },
    ]);
    expect(diff.mismatched).toHaveLength(1);
    expect(diff.mismatched[0].eventId).toBe('mismatch-1');
  });
});
