import { describe, it, expect } from 'vitest';
import { ValidationError } from '../utils/errors.js';
import {
  addDays, daysInclusive, isoWeekday, selectDates, validatePricingRange,
  parsePricingRequest, applyFactor, planPricingChanges, groupWriteRuns,
  type PricingDay, type PricingRequest,
} from './pricing-plan.js';

const TODAY = '2027-01-01';

function mkDays(from: string, to: string, price: number | null = 139, minNights: number | null = 2): PricingDay[] {
  const out: PricingDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, price, minNights, occupied: false });
  return out;
}
const req = (o: Partial<PricingRequest>): PricingRequest => ({ from: '2027-05-01', to: '2027-05-31', dryRun: true, ...o });

describe('Datumshelfer', () => {
  it('addDays / daysInclusive', () => {
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(daysInclusive('2027-05-01', '2027-05-01')).toBe(1);
    expect(daysInclusive('2027-05-01', '2027-05-10')).toBe(10);
  });
  it('isoWeekday Mo und So', () => {
    expect(isoWeekday('2026-11-23')).toBe(1);
    expect(isoWeekday('2026-11-22')).toBe(7);
  });
  it('selectDates mit weekdays [5,6] über zwei Wochen', () => {
    expect(selectDates('2027-05-03', '2027-05-16', [5, 6])).toEqual(['2027-05-07', '2027-05-08', '2027-05-14', '2027-05-15']);
    expect(selectDates('2027-05-03', '2027-05-05')).toHaveLength(3);
  });
});

describe('validatePricingRange', () => {
  it('gültig', () => {
    expect(validatePricingRange('2027-05-01', '2027-05-02')).toEqual({ from: '2027-05-01', to: '2027-05-02' });
  });
  it('from > to', () => {
    expect(() => validatePricingRange('2027-05-02', '2027-05-01')).toThrow(ValidationError);
  });
  it('731 Tage Fehler, 730 ok', () => {
    expect(() => validatePricingRange('2027-01-01', addDays('2027-01-01', 730))).toThrow(/730.*731/s);
    expect(() => validatePricingRange('2027-01-01', addDays('2027-01-01', 729))).not.toThrow();
  });
  it('ungültiges Datum', () => {
    expect(() => validatePricingRange('2027-02-30', '2027-03-01')).toThrow(ValidationError);
    expect(() => validatePricingRange('2027-5-1', '2027-05-02')).toThrow(ValidationError);
    expect(() => validatePricingRange(20270501, '2027-05-02')).toThrow(ValidationError);
  });
});

describe('parsePricingRequest', () => {
  const base = { from: '2027-05-01', to: '2027-05-31' };
  it('gültig mit Defaults und Normalisierung', () => {
    const r = parsePricingRequest({ ...base, price: 160, weekdays: [6, 5, 5], caller: '  bot ' }, TODAY);
    expect(r).toMatchObject({ from: base.from, to: base.to, price: 160, weekdays: [5, 6], dryRun: false, caller: 'bot' });
    expect(parsePricingRequest({ ...base, minNights: 2, caller: '  ' }, TODAY).caller).toBeUndefined();
  });
  it('Body kein Objekt', () => {
    expect(() => parsePricingRequest(null, TODAY)).toThrow(ValidationError);
    expect(() => parsePricingRequest([], TODAY)).toThrow(ValidationError);
  });
  it('unbekannter Schlüssel', () => {
    expect(() => parsePricingRequest({ ...base, price: 1, foo: 1 }, TODAY)).toThrow(/from, to, price/);
  });
  it('to in der Vergangenheit', () => {
    expect(() => parsePricingRequest({ from: '2026-12-01', to: '2026-12-31', price: 100 }, TODAY)).toThrow(ValidationError);
  });
  it('price: 0, -5, 1.234, zu groß', () => {
    for (const p of [0, -5, 1.234, 10001, NaN, '5']) {
      expect(() => parsePricingRequest({ ...base, price: p }, TODAY)).toThrow(ValidationError);
    }
    expect(parsePricingRequest({ ...base, price: 159.85 }, TODAY).price).toBe(159.85);
  });
  it('factor Grenzen', () => {
    expect(() => parsePricingRequest({ ...base, factor: 0 }, TODAY)).toThrow(ValidationError);
    expect(() => parsePricingRequest({ ...base, factor: 3.1 }, TODAY)).toThrow(ValidationError);
    expect(parsePricingRequest({ ...base, factor: 3 }, TODAY).factor).toBe(3);
  });
  it('factor + price', () => {
    expect(() => parsePricingRequest({ ...base, price: 100, factor: 1.1 }, TODAY)).toThrow(ValidationError);
  });
  it('minNights 0, 1.5, 366', () => {
    for (const m of [0, 1.5, 366]) expect(() => parsePricingRequest({ ...base, minNights: m }, TODAY)).toThrow(ValidationError);
    expect(parsePricingRequest({ ...base, minNights: 365 }, TODAY).minNights).toBe(365);
  });
  it('weekdays [0], [], [8], kein Array', () => {
    for (const w of [[0], [], [8], [1.5], 'x']) expect(() => parsePricingRequest({ ...base, price: 1, weekdays: w }, TODAY)).toThrow(ValidationError);
  });
  it('nichts angefragt', () => {
    expect(() => parsePricingRequest(base, TODAY)).toThrow(ValidationError);
  });
  it('dryRun und caller Typen', () => {
    expect(() => parsePricingRequest({ ...base, price: 1, dryRun: 'yes' }, TODAY)).toThrow(ValidationError);
    expect(() => parsePricingRequest({ ...base, price: 1, caller: 5 }, TODAY)).toThrow(ValidationError);
    expect(() => parsePricingRequest({ ...base, price: 1, caller: 'x'.repeat(101) }, TODAY)).toThrow(ValidationError);
    expect(parsePricingRequest({ ...base, price: 1, dryRun: true }, TODAY).dryRun).toBe(true);
  });
});

describe('applyFactor', () => {
  it('Rundung ganze Euro', () => {
    expect(applyFactor(139, 1.15)).toBe(160);
    expect(applyFactor(135, 1.1)).toBe(149);
    expect(applyFactor(129, 1)).toBe(129);
    expect(applyFactor(150, 0.9)).toBe(135);
    expect(applyFactor(159.85, 1)).toBe(160);
  });
});

describe('planPricingChanges', () => {
  it('Wochenend-Zerlegung Mai 2027 → je Wochenende ein Lauf', () => {
    const plan = planPricingChanges(mkDays('2027-04-25', '2027-06-05'), req({ weekdays: [5, 6], price: 160 }), TODAY);
    expect(plan.selectedDays).toBe(9);
    expect(plan.changes).toHaveLength(9);
    const runs = groupWriteRuns(plan.changes.map((c) => ({ date: c.date, payload: { price: c.price!.new } })));
    expect(runs).toHaveLength(5);
    expect(runs[0]).toEqual({ from: '2027-05-01', to: '2027-05-01', nights: 1, payload: { price: 160 } });
    expect(runs[1]).toEqual({ from: '2027-05-07', to: '2027-05-08', nights: 2, payload: { price: 160 } });
  });
  it('belegte Tage → skipped, nicht in changes', () => {
    const days = mkDays('2027-05-01', '2027-05-03');
    days[1] = { ...days[1], occupied: true, occupiedReason: 'Reservierung HM123' };
    days[2] = { ...days[2], occupied: true };
    const plan = planPricingChanges(days, req({ to: '2027-05-03', price: 160 }), TODAY);
    expect(plan.changes.map((c) => c.date)).toEqual(['2027-05-01']);
    expect(plan.skipped).toEqual([
      { date: '2027-05-02', reason: 'Reservierung HM123' },
      { date: '2027-05-03', reason: 'belegt (Reservierung)' },
    ]);
  });
  it('Vergangenheit und fehlender Tag', () => {
    const plan = planPricingChanges(mkDays('2027-01-01', '2027-01-03'), req({ from: '2026-12-31', to: '2027-01-04', price: 160 }), TODAY);
    expect(plan.skipped).toEqual([
      { date: '2026-12-31', reason: 'Tag liegt in der Vergangenheit' },
      { date: '2027-01-04', reason: 'kein Kalendertag vom Anbieter' },
    ]);
    expect(plan.changes.map((c) => c.date)).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });
  it('factor ohne aktuellen Preis', () => {
    const plan = planPricingChanges(mkDays('2027-05-01', '2027-05-01', null), req({ to: '2027-05-01', factor: 1.1 }), TODAY);
    expect(plan.skipped).toEqual([{ date: '2027-05-01', reason: 'kein aktueller Preis für factor' }]);
  });
  it('unchanged', () => {
    const plan = planPricingChanges(mkDays('2027-05-01', '2027-05-02', 160), req({ to: '2027-05-02', price: 160 }), TODAY);
    expect(plan.unchanged).toEqual(['2027-05-01', '2027-05-02']);
    expect(plan.changes).toEqual([]);
  });
  it('gemischt price+minNights, minNights schon gleich → change mit beiden Feldern', () => {
    const plan = planPricingChanges(mkDays('2027-05-01', '2027-05-01', 139, 2), req({ to: '2027-05-01', price: 160, minNights: 2 }), TODAY);
    expect(plan.changes).toEqual([{ date: '2027-05-01', price: { old: 139, new: 160 }, minNights: { old: 2, new: 2 } }]);
  });
  it('nur minNights: kein price-Feld', () => {
    const plan = planPricingChanges(mkDays('2027-05-01', '2027-05-01'), req({ to: '2027-05-01', minNights: 3 }), TODAY);
    expect(plan.changes).toEqual([{ date: '2027-05-01', minNights: { old: 2, new: 3 } }]);
  });
  it('Faktor mit Rundung', () => {
    const plan = planPricingChanges(mkDays('2027-05-01', '2027-05-01', 135), req({ to: '2027-05-01', factor: 1.1 }), TODAY);
    expect(plan.changes[0].price).toEqual({ old: 135, new: 149 });
  });
});

describe('groupWriteRuns', () => {
  it('Lücke → neuer Lauf', () => {
    const runs = groupWriteRuns([
      { date: '2027-05-01', payload: { price: 1 } }, { date: '2027-05-02', payload: { price: 1 } }, { date: '2027-05-04', payload: { price: 1 } },
    ]);
    expect(runs).toEqual([
      { from: '2027-05-01', to: '2027-05-02', nights: 2, payload: { price: 1 } },
      { from: '2027-05-04', to: '2027-05-04', nights: 1, payload: { price: 1 } },
    ]);
  });
  it('wechselnder Payload (Faktor) → neuer Lauf; Schlüsselreihenfolge egal; unsortierte Eingabe', () => {
    const runs = groupWriteRuns([
      { date: '2027-05-03', payload: { price: 150, minNights: 2 } },
      { date: '2027-05-01', payload: { price: 140, minNights: 2 } },
      { date: '2027-05-02', payload: { minNights: 2, price: 140 } },
    ]);
    expect(runs.map((r) => [r.from, r.to, r.nights])).toEqual([['2027-05-01', '2027-05-02', 2], ['2027-05-03', '2027-05-03', 1]]);
  });
});
