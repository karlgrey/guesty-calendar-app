// #793: Änderungserkennung An-/Abreise (pure) + Nachrichtentexte für die Putzcrew.
import { describe, it, expect } from 'vitest';
import {
  detectTimesChange,
  buildTimesChangeMessages,
  type TimesSnapshot,
} from './reservation-times-change.js';

const TODAY = '2027-02-01';

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
    expect(detectTimesChange(snap(), snap(), TODAY)).toBeNull();
  });

  it('kein Vorher-Stand (neue Reservierung) -> null', () => {
    expect(detectTimesChange(null, snap({ planned_departure: '18:00' }), TODAY)).toBeNull();
  });

  it('erkennt planned_departure', () => {
    const c = detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'planned_departure', from: null, to: '18:00' }]);
  });

  it('erkennt planned_arrival', () => {
    const c = detectTimesChange(snap({ planned_arrival: '16:00' }), snap({ planned_arrival: '14:00' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'planned_arrival', from: '16:00', to: '14:00' }]);
  });

  it('erkennt check_in-Datum (localized-Vorrang)', () => {
    const c = detectTimesChange(snap(), snap({ check_in_localized: '2027-02-20' }), TODAY);
    expect(c?.changes).toEqual([{ field: 'check_in', from: '2027-02-21', to: '2027-02-20' }]);
  });

  it('erkennt check_out-Datum; Fallback auf check_in/out ohne localized', () => {
    const b = snap({ check_in_localized: null, check_out_localized: null });
    const a = snap({ check_in_localized: null, check_out_localized: null, check_out: '2027-02-24T11:00:00.000Z' });
    expect(detectTimesChange(b, a, TODAY)?.changes).toEqual([{ field: 'check_out', from: '2027-02-23', to: '2027-02-24' }]);
  });

  it('mehrere Felder gleichzeitig', () => {
    const c = detectTimesChange(
      snap(),
      snap({ check_in_localized: '2027-02-20', check_out_localized: '2027-02-22', planned_departure: '18:00', planned_arrival: '13:00' }),
      TODAY,
    );
    expect(c?.changes.map((x) => x.field).sort()).toEqual(['check_in', 'check_out', 'planned_arrival', 'planned_departure']);
  });

  it('Zeitformat HH:MM:SS wird auf HH:MM normalisiert (keine Scheinänderung)', () => {
    expect(detectTimesChange(snap({ planned_departure: '12:00:00' }), snap({ planned_departure: '12:00' }), TODAY)).toBeNull();
  });

  it('Check-in in der Vergangenheit -> null', () => {
    const b = snap({ check_in_localized: '2026-01-20', check_out_localized: '2026-01-25' });
    const a = snap({ check_in_localized: '2026-01-20', check_out_localized: '2026-01-25', planned_departure: '18:00' });
    expect(detectTimesChange(b, a, TODAY)).toBeNull();
  });

  it('Check-in heute zählt noch als Zukunft', () => {
    const a = snap({ check_in_localized: TODAY, planned_arrival: '13:00' });
    expect(detectTimesChange(snap({ check_in_localized: TODAY }), a, TODAY)).not.toBeNull();
  });

  it.each(['canceled', 'cancelled', 'declined', 'inquiry', 'closed', 'expired'])('Status %s -> null', (status) => {
    expect(detectTimesChange(snap({ status }), snap({ status, planned_departure: '18:00' }), TODAY)).toBeNull();
  });

  it.each(['confirmed', 'reserved'])('Status %s löst aus', (status) => {
    expect(detectTimesChange(snap({ status }), snap({ status, planned_departure: '18:00' }), TODAY)).not.toBeNull();
  });
});

describe('buildTimesChangeMessages', () => {
  const ctx = { objectLabel: 'Farmhouse', defaultCheckIn: '16:00', defaultCheckOut: '12:00' };

  it('Late-Checkout', () => {
    const c = detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY)!;
    const [m] = buildTimesChangeMessages(c, ctx);
    expect(m.text).toBe('Farmhouse, Di 23.02.: Check-out 18:00 statt 12:00 (Late-Checkout). Micha');
    expect(m.field).toBe('planned_departure');
    expect(m.value).toBe('18:00');
  });

  it('früher Check-in (U19)', () => {
    const a = snap({ check_in_localized: '2026-10-13', check_out_localized: '2026-10-15', planned_arrival: '14:00' });
    const b = snap({ check_in_localized: '2026-10-13', check_out_localized: '2026-10-15' });
    const c = detectTimesChange(b, a, '2026-10-01')!;
    const [m] = buildTimesChangeMessages(c, { objectLabel: 'U19', defaultCheckIn: '16:00', defaultCheckOut: '12:00' });
    expect(m.text).toBe('U19, Di 13.10.: Check-in 14:00 statt 16:00 (früher Check-in). Micha');
  });

  it('"statt" nimmt vorherigen planned-Wert, wenn gesetzt', () => {
    const c = detectTimesChange(snap({ planned_departure: '15:00' }), snap({ planned_departure: '18:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out 18:00 statt 15:00 (Late-Checkout). Micha');
  });

  it('Datumsänderung', () => {
    const b = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-03' });
    const a = snap({ check_in_localized: '2026-11-30', check_out_localized: '2026-12-02' });
    const c = detectTimesChange(b, a, '2026-11-01')!;
    const ms = buildTimesChangeMessages(c, ctx);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('Farmhouse: neu 30.11.–02.12. (statt 01.–03.12.). Micha');
    expect(ms[0].field).toBe('dates');
    expect(ms[0].value).toBe('2026-11-30/2026-12-02');
  });

  it('Datum + Zeit gleichzeitig -> zwei Nachrichten', () => {
    const b = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-03' });
    const a = snap({ check_in_localized: '2026-12-01', check_out_localized: '2026-12-04', planned_departure: '18:00' });
    const ms = buildTimesChangeMessages(detectTimesChange(b, a, '2026-11-01')!, ctx);
    expect(ms.map((m) => m.field).sort()).toEqual(['dates', 'planned_departure']);
  });

  it('Zurücksetzen auf Standardzeit', () => {
    const c = detectTimesChange(snap({ planned_departure: '18:00' }), snap({ planned_departure: '12:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)[0].text).toBe('Farmhouse, Di 23.02.: Check-out wieder 12:00 (Standard). Micha');
  });

  it('planned auf null (Guesty liefert nichts) -> keine Nachricht', () => {
    const c = detectTimesChange(snap({ planned_departure: '18:00' }), snap({ planned_departure: null }), TODAY)!;
    expect(buildTimesChangeMessages(c, ctx)).toEqual([]);
  });

  it('ohne bekannte Standardzeit: kein "statt"/Klammer', () => {
    const c = detectTimesChange(snap(), snap({ planned_departure: '18:00' }), TODAY)!;
    const [m] = buildTimesChangeMessages(c, { objectLabel: 'Farmhouse', defaultCheckIn: null, defaultCheckOut: null });
    expect(m.text).toBe('Farmhouse, Di 23.02.: Check-out 18:00. Micha');
  });

  it('früher Check-out / später Check-in bekommen neutrale Klammer', () => {
    const c1 = detectTimesChange(snap(), snap({ planned_departure: '10:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c1, ctx)[0].text).toContain('(früher Check-out)');
    const c2 = detectTimesChange(snap(), snap({ planned_arrival: '19:00' }), TODAY)!;
    expect(buildTimesChangeMessages(c2, ctx)[0].text).toContain('(später Check-in)');
  });
});
