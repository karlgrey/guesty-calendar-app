import { describe, it, expect } from 'vitest';
import type { GuestyCalendarDay } from '../types/guesty.js';
import {
  classifyGuestyDay,
  groupGuestyBlockedRanges,
  planGuestyMutation,
  toRuns,
} from './guesty-availability.js';

// Fixtures nach dem Live-Befund #799/#802 (Farmhouse): manueller Block = blockRefs type 'm',
// Vorbereitungszeit = 'pt', Reservierung = blockRef mit reservation-Objekt (+ blocks.b).
function day(date: string, extra: Partial<GuestyCalendarDay> = {}): GuestyCalendarDay {
  return {
    date, listingId: 'L-FH', currency: 'EUR', price: 300, minNights: 2, status: 'available', ...extra,
  };
}
const manual = (date: string, note = '') => day(date, {
  status: 'unavailable', note, blocks: { m: true },
  blockRefs: [{ _id: 'blk1', listingId: 'L-FH', startDate: '2026-11-19', endDate: '2026-11-22', type: 'm', note }],
});
const booked = (date: string, status = 'confirmed') => day(date, {
  status: 'unavailable', blocks: { b: true },
  blockRefs: [{
    _id: 'blkR', listingId: 'L-FH', startDate: date, endDate: date, type: 'b', reservationId: 'res-tj',
    reservation: { _id: 'res-tj', listingId: 'L-FH', checkIn: '2026-11-12', checkOut: '2026-11-14', status },
  }],
});
const prep = (date: string) => day(date, {
  status: 'unavailable', blocks: { pt: true },
  blockRefs: [{ _id: 'blkP', listingId: 'L-FH', startDate: date, endDate: date, type: 'pt' }],
});

describe('classifyGuestyDay', () => {
  it('freier Tag', () => {
    expect(classifyGuestyDay(day('2026-11-18'))).toMatchObject({ date: '2026-11-18', available: true, blockType: null });
  });
  it('manueller Block (m) mit Notiz', () => {
    expect(classifyGuestyDay(manual('2026-11-19', 'Nadine'))).toMatchObject({
      available: false, blockType: 'manual', blockTypes: ['m'], remarks: 'Nadine',
    });
  });
  it('Reservierung (bestätigt) und Hold (reserved) sind unterscheidbar', () => {
    expect(classifyGuestyDay(booked('2026-11-13'))).toMatchObject({ blockType: 'reservation', reservationId: 'res-tj' });
    expect(classifyGuestyDay(booked('2026-11-13', 'reserved'))).toMatchObject({ blockType: 'hold', reservationId: 'res-tj' });
  });
  it('Late-Checkout-Folgetag-Block (unsere Notiz) ist eigener Typ', () => {
    expect(classifyGuestyDay(manual('2026-11-15', 'Late-Checkout res-tj'))).toMatchObject({ blockType: 'late-checkout' });
  });
  it('Vorbereitungszeit (pt) ist "other"', () => {
    expect(classifyGuestyDay(prep('2026-11-14'))).toMatchObject({ blockType: 'other', blockTypes: ['pt'] });
  });
  it('unavailable ohne blockRefs, nur Flag m → manual; ohne alles → other', () => {
    expect(classifyGuestyDay(day('2026-11-20', { status: 'unavailable', blocks: { m: true } })).blockType).toBe('manual');
    expect(classifyGuestyDay(day('2026-11-20', { status: 'unavailable' })).blockType).toBe('other');
  });
  it('m gemischt mit pt ist nicht manual', () => {
    const d = manual('2026-11-19');
    d.blockRefs!.push({ _id: 'p', listingId: 'L-FH', startDate: d.date, endDate: d.date, type: 'pt' });
    expect(classifyGuestyDay(d).blockType).toBe('other');
  });
  it('ISO-Datum wird auf YYYY-MM-DD gekürzt', () => {
    expect(classifyGuestyDay(day('2026-11-18T00:00:00.000Z')).date).toBe('2026-11-18');
  });
});

describe('groupGuestyBlockedRanges', () => {
  it('trennt Bereiche nach Block-Typ und Reservierung', () => {
    const days = [
      booked('2026-11-13'), prep('2026-11-14'), manual('2026-11-15', 'Late-Checkout res-tj'),
      day('2026-11-16'), manual('2026-11-19', 'Nadine'), manual('2026-11-20'), manual('2026-11-21'), day('2026-11-22'),
    ].map(classifyGuestyDay);
    expect(groupGuestyBlockedRanges(days)).toEqual([
      { from: '2026-11-13', to: '2026-11-13', nights: 1, remarks: '', blockType: 'reservation', reservationId: 'res-tj' },
      { from: '2026-11-14', to: '2026-11-14', nights: 1, remarks: '', blockType: 'other' },
      { from: '2026-11-15', to: '2026-11-15', nights: 1, remarks: 'Late-Checkout res-tj', blockType: 'late-checkout' },
      { from: '2026-11-19', to: '2026-11-21', nights: 3, remarks: 'Nadine', blockType: 'manual' },
    ]);
  });
});

describe('toRuns', () => {
  it('fasst lückenlose Tage zu Läufen zusammen', () => {
    expect(toRuns(['2026-11-19', '2026-11-20', '2026-11-22', '2026-11-30', '2026-12-01'])).toEqual([
      { from: '2026-11-19', to: '2026-11-20', nights: 2 },
      { from: '2026-11-22', to: '2026-11-22', nights: 1 },
      { from: '2026-11-30', to: '2026-12-01', nights: 2 },
    ]);
    expect(toRuns([])).toEqual([]);
  });
});

describe('planGuestyMutation', () => {
  const today = '2026-11-13';
  it('unblock: nur manuelle Tage werden geschrieben, Rest in skipped mit Grund', () => {
    const days = [
      booked('2026-11-13'), prep('2026-11-14'), manual('2026-11-15', 'Late-Checkout res-tj'),
      day('2026-11-16'), manual('2026-11-19'), manual('2026-11-20'),
    ].map(classifyGuestyDay);
    const plan = planGuestyMutation(days, 'unblock', today);
    expect(plan.write).toEqual(['2026-11-19', '2026-11-20']);
    expect(plan.unchanged).toEqual(['2026-11-16']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.skipped.map((s) => [s.date, s.blockType])).toEqual([
      ['2026-11-13', 'reservation'], ['2026-11-14', 'other'], ['2026-11-15', 'late-checkout'],
    ]);
    expect(plan.skipped[0].reason).toMatch(/Reservierung/);
    expect(plan.skipped[1].reason).toMatch(/pt/);
    expect(plan.skipped[2].reason).toMatch(/Late-Checkout/);
  });
  it('unblock: Hold wird nicht angefasst', () => {
    const plan = planGuestyMutation([classifyGuestyDay(booked('2026-11-20', 'reserved'))], 'unblock', today);
    expect(plan.write).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ blockType: 'hold' });
    expect(plan.skipped[0].reason).toMatch(/Hold/);
  });
  it('block: Reservierung oder Hold im Zeitraum → conflicts', () => {
    const days = [day('2026-11-19'), booked('2026-11-20'), booked('2026-11-21', 'reserved')].map(classifyGuestyDay);
    const plan = planGuestyMutation(days, 'block', today);
    expect(plan.conflicts.map((c) => c.date)).toEqual(['2026-11-20', '2026-11-21']);
  });
  it('block: nur freie Tage schreiben, schon geblockte bleiben unberührt', () => {
    const days = [day('2026-11-19'), manual('2026-11-20'), prep('2026-11-21'), day('2026-11-22')].map(classifyGuestyDay);
    const plan = planGuestyMutation(days, 'block', today);
    expect(plan.write).toEqual(['2026-11-19', '2026-11-22']);
    expect(plan.unchanged).toEqual(['2026-11-20']);
    expect(plan.skipped).toEqual([{ date: '2026-11-21', blockType: 'other', reason: 'bereits geblockt (pt) — nicht angefasst' }]);
    expect(plan.conflicts).toEqual([]);
  });
  it('Tage vor heute werden nie geschrieben', () => {
    const plan = planGuestyMutation([manual('2026-11-12'), manual('2026-11-13')].map(classifyGuestyDay), 'unblock', today);
    expect(plan.write).toEqual(['2026-11-13']);
    expect(plan.skipped[0]).toMatchObject({ date: '2026-11-12', reason: 'Tag liegt in der Vergangenheit' });
  });
});
