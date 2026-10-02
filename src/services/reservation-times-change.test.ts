// #793: Änderungserkennung An-/Abreise (pure) + Nachrichtentexte für die Putzcrew.
import { describe, it, expect } from 'vitest';
import {
  detectTimesChange,
  buildTimesChangeMessages,
  type TimesSnapshot,
} from './reservation-times-change.js';

const TODAY = '2027-02-01';
const DEF = { checkIn: '16:00', checkOut: '12:00' };

/** Standard-Aufruf mit bekannter Listing-Standardzeit (#793-Fix: NULL = Standard). */
const detect = (
  b: TimesSnapshot | null,
  a: TimesSnapshot,
  today: string = TODAY,
  defaults: { checkIn: string | null; checkOut: string | null } | null = DEF,
) => detectTimesChange(b, a, today, defaults);

function snap(over: Partial<TimesSnapshot> = {}): TimesSnapshot {
  return {
    reservation_id: 'res-1',
    listing_id: 'L1',
    status: 'confirmed',
    check_in: '2027-02-21T14:00:00.000Z',
    check_out: '2027-02-23T11:00:00.000Z',
    check_in_localized: '2027-02-21',
    check_out_localized: '2027-02-23',
    planned_arrival: null,
    planned_departure: null,
    ...over,
  };
}

describe('detectTimesChange', () => {
  it('keine Änderung -> null', () => {
    expect(detect(snap(), snap(), TODAY)).toBeNull();
  });

  it('kein Vorher-Stand (neue Reservierung) -> null', () => {
    expect(detect(null, snap({ planned_departure: '18:00' }), TODAY)).toBeNull();
  });

  it('erkennt planned_departure', () => {
    const c = detect(snap(), snap({ planned_departure: '18:00' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'planned_departure', from: '12:00', to: '18:00' }]);
  });

  it('erkennt planned_arrival', () => {
    const c = detect(snap({ planned_arrival: '16:00' }), snap({ planned_arrival: '14:00' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'planned_arrival', from: '16:00', to: '14:00' }]);
  });

  it('erkennt check_in-Datum (localized-Vorrang)', () => {
    const c = detect(snap(), snap({ check_in_localized: '2027-02-20' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'check_in', from: '2027-02-21', to: '2027-02-20' }]);
  });

  it('erkennt check_out-Datum; Fallback auf check_in/out ohne localized', () => {
    const b = snap({ check_in_localized: null, check_out_localized: null });
    const a = snap({ check_in_localized: null, check_out_localized: null, check_out: '2027-02-24T11:00:00.000Z' });
    expect(detect(b, a, TODAY)?.changes).toEqual([{ field: 'check_out', from: '2027-02-23', to: '2027-02-24' }]);
  });

  it('mehrere Felder gleichzeitig', () => {
    const c = detect(
      snap(),
      snap({ check_in_localized: '2027-02-20', check_out_localized: '2027-02-22', planned_departure: '18:00', planned_arrival: '13:00' }),
      TODAY,
    );
    expect(c?.changes.map((x) => x.field).sort()).toEqual(['check_in', 'check_out', 'planned_arrival', 'planned_departure']);
  });

  it('Zeitformat HH:MM:SS wird auf HH:MM normalisiert (keine Scheinänderung)', () => {
    expect(detect(snap({ planned_departure: '12:00:00' }), snap({ planned_departure: '12:00' }), TODAY)).toBeNull();
  });

  it('Check-out in der Vergangenheit -> null', () => {
    const b = snap({ check_in_localized: '2026-01-20', check_out_localized: '2026-01-25' });
    const a = snap({ check_in_localized: '2026-01-20', check_out_localized: '2026-01-25', planned_departure: '18:00' });
    expect(detect(b, a, TODAY)).toBeNull();
  });

  it('laufender Aufenthalt (Check-in gestern, Check-out morgen) löst aus — Late-Checkout wird meist in-house zugesagt', () => {
    const b = snap({ check_in_localized: '2027-01-31', check_out_localized: '2027-02-02' });
    const a = snap({ check_in_localized: '2027-01-31', check_out_localized: '2027-02-02', planned_departure: '18:00' });
    expect(detect(b, a, TODAY)?.changes).toEqual([{ field: 'planned_departure', from: '12:00', to: '18:00' }]);
  });

  it('Check-out heute zählt noch', () => {
    const b = snap({ check_in_localized: '2027-01-30', check_out_localized: TODAY });
    const a = snap({ check_in_localized: '2027-01-30', check_out_localized: TODAY, planned_departure: '18:00' });
    expect(detect(b, a, TODAY)).not.toBeNull();
  });

  it('Check-in heute zählt noch als Zukunft', () => {
    const a = snap({ check_in_localized: TODAY, planned_arrival: '13:00' });
    expect(detect(snap({ check_in_localized: TODAY }), a, TODAY)).not.toBeNull();
  });

  it.each(['canceled', 'cancelled', 'declined', 'inquiry', 'closed', 'expired'])('Status %s -> null', (status) => {
    expect(detect(snap({ status }), snap({ status, planned_departure: '18:00' }), TODAY)).toBeNull();
  });

  it.each(['confirmed', 'reserved'])('Status %s löst aus', (status) => {
    expect(detect(snap({ status }), snap({ status, planned_departure: '18:00' }), TODAY)).not.toBeNull();
  });
});

describe('buildTimesChangeMessages', () => {
  const ctx = { objectLabel: 'Farmhouse', defaultCheckIn: '16:00', defaultCheckOut: '12:00' };

  it('Late-Checkout', () => {
    const c = detect(snap(), snap({ planned_departure: '18:00' }), TODAY)!;
    const [m] = buildTimesChangeMessages(c, ctx);
    expect(m.text).toBe('Farmhouse, Di 23.02.: Check-out 18:00 statt 12:00 (Late-Checkout). Micha');
    expect(m.field).toBe('planned_departure');
    expect(m.value).toBe('18:00');
  });

  it('früher Check-in (U19)', () => {
    const a = snap({ check_in_localized: '2026-10-13', check_out_localized: '2026-10-15', planned_arrival: '14:00' });
    const b = snap({ check_in_localized: '2026-10-13', check_out_localized: '2026-10-15' });
    const c = detect(b, a, '2026-10-01')!;
    const [m] = buildTimesChangeMessages(c, { objectLabel: 'U19', defaultCheckIn: '16:00', defaultCheckOut: '12:00' });
    expect(m.text).toBe('U19, Di 13.10.: Check-in 14:00 statt 16:00 (früher Check-in). Micha');
  });

  it('"statt" nimmt vorherigen planned-Wert, wenn gesetzt', () => {
    const c = detect(snap({ planned_departure: '15:00' }), snap({ planned_departure: '18:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out 18:00 statt 15:00 (Late-Checkout). Micha');
  });

  it('Datumsänderung', () => {
    const b = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-03' });
    const a = snap({ check_in_localized: '2026-11-30', check_out_localized: '2026-12-02' });
    const c = detect(b, a, '2026-11-01')!;
    const ms = buildTimesChangeMessages(c, ctx);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('Farmhouse: neu 30.11.–02.12. (statt 01.–03.12.). Micha');
    expect(ms[0].field).toBe('dates');
    expect(ms[0].value).toBe('2026-11-30/2026-12-02');
  });

  it('Datum + Zeit gleichzeitig -> zwei Nachrichten', () => {
    const b = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-03' });
    const a = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-04', planned_departure: '18:00' });
    const ms = buildTimesChangeMessages(detect(b, a, '2026-11-01')!, ctx);
    expect(ms.map((m) => m.field).sort()).toEqual(['dates', 'planned_departure']);
  });

  it('Zurücksetzen auf Standardzeit', () => {
    const c = detect(snap({ planned_departure: '18:00' }), snap({ planned_departure: '12:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out wieder 12:00 (Standard). Micha');
  });

  it('planned 18:00 -> NULL = wieder Standardzeit (mit Listing-Standard)', () => {
    const c = detect(snap({ planned_departure: '18:00' }), snap({ planned_departure: null }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out wieder 12:00 (Standard). Micha');
  });

  it('planned 18:00 -> NULL ohne Listing-Standard -> keine Nachricht', () => {
    const c = detect(snap({ planned_departure: '18:00' }), snap({ planned_departure: null }), TODAY, null)!;
    expect(buildTimesChangeMessages(c, ctx)).toEqual([]);
  });

  it('ohne bekannte Standardzeit: kein "statt"/Klammer', () => {
    // Defensiv: detect meldet NULL -> Wert ohne Listing-Standard nicht mehr; Builder-Pfad trotzdem absichern.
    const c0 = detect(snap(), snap({ planned_departure: '18:00' }), TODAY)!;
    const c = { ...c0, changes: c0.changes.map((x) => ({ ...x, from: null })) };
    const [m] = buildTimesChangeMessages(c, { objectLabel: 'Farmhouse', defaultCheckIn: null, defaultCheckOut: null });
    expect(m.text).toBe('Farmhouse, Di 23.02.: Check-out 18:00. Micha');
  });

  it('früher Check-out / später Check-in bekommen neutrale Klammer', () => {
    const c1 = detect(snap(), snap({ planned_departure: '10:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c1, ctx)[0].text).toContain('(früher Check-out)');
    const c2 = detect(snap(), snap({ planned_arrival: '19:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c2, ctx)[0].text).toContain('(später Check-in)');
  });
});

describe('detectTimesChange: fehlende Zeit = Listing-Standardzeit (#793-Fix)', () => {
  const FARM = { checkIn: '08:00', checkOut: '12:00' };
  const farmCtx = { objectLabel: 'Farmhouse', defaultCheckIn: '08:00', defaultCheckOut: '12:00' };

  it('AVOW-Fall: NULL/NULL -> 08:00/12:00 (= Standard) + Datumsänderung -> genau EINE Meldung (dates)', () => {
    const b = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-03' });
    const a = snap({
      check_in_localized: '2026-11-30', check_out_localized: '2026-12-02',
      planned_arrival: '08:00', planned_departure: '12:00',
    });
    const c = detectTimesChange(b, a, '2026-11-01', FARM)!;
    expect(c.changes.map((x) => x.field).sort()).toEqual(['check_in', 'check_out']);
    const ms = buildTimesChangeMessages(c, farmCtx);
    expect(ms.map((m) => m.field)).toEqual(['dates']);
    expect(ms[0].text).toBe('Farmhouse: neu 30.11.–02.12. (statt 01.–03.12.). Micha');
  });

  it('NULL -> Standard: keine Änderung', () => {
    expect(detectTimesChange(snap(), snap({ planned_arrival: '08:00', planned_departure: '12:00' }), TODAY, FARM)).toBeNull();
  });

  it('NULL -> 18:00: Meldung (statt Standard)', () => {
    const c = detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY, FARM)!;
    expect(c.changes).toEqual([{ field: 'planned_departure', from: '12:00', to: '18:00' }]);
    expect(buildTimesChangeMessages(c, farmCtx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out 18:00 statt 12:00 (Late-Checkout). Micha');
  });

  it('18:00 -> NULL: Meldung "wieder 12:00 (Standard)"', () => {
    const c = detectTimesChange(snap({ planned_departure: '18:00' }), snap(), TODAY, FARM)!;
    expect(c.changes).toEqual([{ field: 'planned_departure', from: '18:00', to: '12:00' }]);
    expect(buildTimesChangeMessages(c, farmCtx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out wieder 12:00 (Standard). Micha');
  });

  it('18:00 -> 12:00: Meldung', () => {
    expect(detectTimesChange(snap({ planned_departure: '18:00' }), snap({ planned_departure: '12:00' }), TODAY, FARM)).not.toBeNull();
  });

  it('Standard -> Standard (NULL vs. 12:00, 12:00 vs. 12:00): keine Meldung', () => {
    expect(detectTimesChange(snap({ planned_departure: '12:00' }), snap({ planned_departure: '12:00' }), TODAY, FARM)).toBeNull();
    expect(detectTimesChange(snap({ planned_departure: '12:00' }), snap(), TODAY, FARM)).toBeNull();
  });

  it('HH:MM:SS wird gekürzt (Wert und Standard)', () => {
    const def = { checkIn: '08:00:00', checkOut: '12:00:00' };
    expect(detectTimesChange(snap(), snap({ planned_departure: '12:00:00' }), TODAY, def)).toBeNull();
    expect(detectTimesChange(snap({ planned_arrival: '08:00:00' }), snap(), TODAY, def)).toBeNull();
  });

  it('ohne Listing-Standard: NULL -> Wert keine Meldung (konservativ)', () => {
    expect(detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY, null)).toBeNull();
    expect(detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY, { checkIn: null, checkOut: null })).toBeNull();
    expect(detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY)).toBeNull();
  });

  it('ohne Listing-Standard: Wert -> anderer Wert meldet weiterhin', () => {
    expect(detectTimesChange(snap({ planned_departure: '15:00' }), snap({ planned_departure: '18:00' }), TODAY, null)).not.toBeNull();
  });
});
