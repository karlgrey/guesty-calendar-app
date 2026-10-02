// #799: Folgetag-Block nur für Objekte mit Flag; EIN Pfad (Listing-Kalender) für alle Buchungen;
// Block nur setzen, wenn der Tag frei ist; nur entfernen, was wir selbst gesetzt haben.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: { setListingCalendarStatus: vi.fn().mockResolvedValue({}), getCalendar: vi.fn() },
}));
vi.mock('./reservation-update-service.js', () => ({
  updateReservation: vi.fn(),
  isDirectSource: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../config/properties.js', () => ({
  findPropertyByListingId: vi.fn((id: string) =>
    id === 'L-FH' ? { slug: 'farmhouse', blocksNextDayOnLateCheckout: true }
    : id === 'L-U19' ? { slug: 'u19' }
    : id === 'L-HX' ? { slug: 'bootshaus-alte-oder', provider: 'hostex' }
    : undefined),
}));

import { guestyClient } from './guesty-client.js';
import { updateReservation } from './reservation-update-service.js';
import { applyNextDayBlock } from './next-day-block.js';
import logger from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';

const setCal = guestyClient.setListingCalendarStatus as any;
const getCal = guestyClient.getCalendar as any;
const upd = updateReservation as any;
const tgt = (over: Record<string, unknown> = {}) => ({
  reservationId: 'r1', listingId: 'L-FH', checkOutDay: '2026-12-03', ...over,
});
const day = (over: Record<string, unknown> = {}) => ({ date: '2026-12-04', status: 'available', ...over });
const prev = (state: 'set-by-us' | 'already-blocked' | null = null, blockDate: string | null = null) => ({ state, blockDate });
const OURS = { status: 'unavailable', blocks: { m: true }, note: 'Late-Checkout r1', blockRefs: [{ type: 'm', note: 'Late-Checkout r1' }] };

beforeEach(() => {
  vi.clearAllMocks();
  setCal.mockResolvedValue({});
  getCal.mockResolvedValue([day()]);
});

describe('applyNextDayBlock — Anlegen', () => {
  it('Objekt ohne Flag: kein Aufruf, method none, blockState null', async () => {
    for (const listingId of ['L-U19', 'L-HX', 'L-UNBEKANNT']) {
      const r = await applyNextDayBlock(tgt({ listingId }), true, prev(null));
      expect(r).toEqual({ applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag', blockState: null, blockDate: null });
    }
    expect(getCal).not.toHaveBeenCalled();
    expect(setCal).not.toHaveBeenCalled();
  });

  it('Tag frei: ein getCalendar + ein Listing-Kalender-PUT unavailable mit Notiz, set-by-us', async () => {
    const r = await applyNextDayBlock(tgt(), true, prev(null));
    expect(r).toEqual({ applied: true, method: 'listing-calendar', blockState: 'set-by-us', blockDate: '2026-12-04' });
    expect(getCal).toHaveBeenCalledTimes(1);
    expect(getCal).toHaveBeenCalledWith('L-FH', '2026-12-04', '2026-12-04');
    expect(setCal).toHaveBeenCalledTimes(1);
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-04', endDate: '2026-12-04', status: 'unavailable', note: 'Late-Checkout r1' });
  });

  it('Tag unavailable mit pt: KEIN Schreibaufruf, already-blocked mit Typen im Grund', async () => {
    getCal.mockResolvedValue([day({ status: 'unavailable', blockRefs: [{ type: 'pt' }] })]);
    const r = await applyNextDayBlock(tgt(), true, prev(null));
    expect(r).toEqual({ applied: false, method: 'none', reason: 'Folgetag bereits geblockt (pt)', blockState: 'already-blocked', blockDate: '2026-12-04' });
    expect(setCal).not.toHaveBeenCalled();
  });

  it('mehrere Block-Typen werden kommasepariert genannt', async () => {
    getCal.mockResolvedValue([day({ status: 'unavailable', blockRefs: [{ type: 'pt' }, { type: 'b' }] })]);
    const r = await applyNextDayBlock(tgt(), true, prev(null));
    expect(r.reason).toBe('Folgetag bereits geblockt (pt, b)');
  });

  it('Direktbuchung und Kanalbuchung: identischer Pfad, updateReservation nie aufgerufen', async () => {
    const a = await applyNextDayBlock(tgt({ source: 'manual' }), true, prev(null));
    const b = await applyNextDayBlock(tgt({ source: 'airbnb2' }), true, prev(null));
    const c = await applyNextDayBlock(tgt({ source: null }), true, prev(null));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(setCal).toHaveBeenCalledTimes(3);
    expect(upd).not.toHaveBeenCalled();
  });

  it('wanted true bei vorherigem set-by-us: Tag trägt unseren Block (unavailable) -> already-blocked, kein erneutes Schreiben', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    const r = await applyNextDayBlock(tgt(), true, prev('set-by-us'));
    expect(setCal).not.toHaveBeenCalled();
    expect(r).toMatchObject({ applied: false, method: 'none', blockState: 'set-by-us' });
  });

  it('Guesty-Fehler beim Lesen: applied false, error-Details, blockState bleibt wie vorher', async () => {
    getCal.mockRejectedValueOnce(new ExternalApiError('Guesty API error', 500, 'guesty', { message: 'down' }));
    const r = await applyNextDayBlock(tgt(), true, prev(null));
    expect(r).toMatchObject({ applied: false, method: 'listing-calendar', blockState: null });
    expect(r.error).toEqual({ message: 'Guesty API error', details: { message: 'down' } });
    expect(setCal).not.toHaveBeenCalled();
  });

  it('Guesty-Fehler beim Schreiben: 409-Material, blockState bleibt', async () => {
    setCal.mockRejectedValueOnce(new ExternalApiError('Guesty API error', 400, 'guesty', { message: 'dates blocked' }));
    const r = await applyNextDayBlock(tgt(), true, prev(null));
    expect(r).toMatchObject({ applied: false, method: 'listing-calendar', blockState: null });
    expect(r.reason).toMatch(/Guesty/);
    expect(r.error).toEqual({ message: 'Guesty API error', details: { message: 'dates blocked' } });
  });
});

describe('applyNextDayBlock — Rücknahme', () => {
  it('set-by-us + Tag trägt genau unseren m-Block mit Notiz: available, Notiz gelöscht, blockState null', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us'));
    expect(r).toEqual({ applied: true, method: 'listing-calendar', blockState: null, blockDate: null });
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-04', endDate: '2026-12-04', status: 'available', note: '' });
  });

  it('Notiz nur an der blockRef (nicht am Tag) reicht', async () => {
    getCal.mockResolvedValue([day({ status: 'unavailable', blockRefs: [{ type: 'm', note: 'Late-Checkout r1' }] })]);
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us'));
    expect(r.applied).toBe(true);
  });

  it.each([
    ['pt-Block', { status: 'unavailable', blockRefs: [{ type: 'pt' }] }],
    ['m + pt gemischt', { status: 'unavailable', note: 'Late-Checkout r1', blockRefs: [{ type: 'm' }, { type: 'pt' }] }],
    ['Reservierung', { status: 'unavailable', blockRefs: [{ type: 'b' }] }],
    ['fremde Notiz', { status: 'unavailable', note: 'Handwerker', blockRefs: [{ type: 'm', note: 'Handwerker' }] }],
    ['Notiz einer anderen Reservierung', { status: 'unavailable', note: 'Late-Checkout r2', blockRefs: [{ type: 'm' }] }],
    ['Tag inzwischen frei', { status: 'available' }],
  ])('set-by-us, aber %s: kein Schreibaufruf, Warn-Log, blockState null', async (_n, d) => {
    getCal.mockResolvedValue([day(d)]);
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us'));
    expect(setCal).not.toHaveBeenCalled();
    expect(r).toEqual({
      applied: false, method: 'none', reason: 'Block nicht von uns gesetzt / Tag anders belegt — nicht angefasst', blockState: null, blockDate: null,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each(['already-blocked', null] as const)('previousState %s: kein Guesty-Aufruf, blockState null', async (prevState) => {
    const r = await applyNextDayBlock(tgt(), false, prev(prevState));
    expect(getCal).not.toHaveBeenCalled();
    expect(setCal).not.toHaveBeenCalled();
    expect(r).toMatchObject({ applied: false, method: 'none', blockState: null });
  });

  it('Guesty-Fehler bei Rücknahme: error gesetzt, blockState bleibt set-by-us (Retry)', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    setCal.mockRejectedValueOnce(new Error('boom'));
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us', '2026-12-04'));
    expect(r).toMatchObject({ applied: false, method: 'listing-calendar', blockState: 'set-by-us', blockDate: '2026-12-04' });
    expect(r.error?.message).toBe('boom');
  });

  it('Logs enthalten keine Notiztexte', async () => {
    getCal.mockResolvedValue([day({ status: 'unavailable', note: 'GEHEIMER GASTTEXT', blockRefs: [{ type: 'm', note: 'GEHEIMER GASTTEXT' }] })]);
    await applyNextDayBlock(tgt(), false, prev('set-by-us'));
    expect(JSON.stringify((logger.warn as any).mock.calls)).not.toContain('GEHEIMER');
  });
});

describe('applyNextDayBlock — Zieltag Check-out + 1 (#802)', () => {
  it.each([
    ['2026-12-03', '2026-12-04'],
    ['2026-10-31', '2026-11-01'],
    ['2026-12-31', '2027-01-01'],
    ['2028-02-28', '2028-02-29'],
  ])('Check-out %s -> Zieltag %s: getCalendar und PUT nur mit dem Zieltag, nie mit dem Check-out-Tag', async (out, target) => {
    getCal.mockResolvedValue([day({ date: target })]);
    const r = await applyNextDayBlock(tgt({ checkOutDay: out }), true, prev());
    expect(getCal).toHaveBeenCalledWith('L-FH', target, target);
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: target, endDate: target, status: 'unavailable', note: 'Late-Checkout r1' });
    for (const c of [...getCal.mock.calls, ...setCal.mock.calls]) {
      expect(JSON.stringify(c)).not.toContain(out);
    }
    expect(r).toMatchObject({ blockState: 'set-by-us', blockDate: target });
  });

  it('Check-out-Tag pt-geblockt ist egal: Mock liefert Zieltag frei -> geblockt; belegt -> already-blocked mit Zieltag', async () => {
    getCal.mockResolvedValue([day({ status: 'unavailable', blockRefs: [{ type: 'b' }] })]);
    const r = await applyNextDayBlock(tgt(), true, prev());
    expect(r).toMatchObject({ applied: false, blockState: 'already-blocked', blockDate: '2026-12-04' });
    expect(setCal).not.toHaveBeenCalled();
  });

  it('set-by-us: Rücknahme gibt genau Check-out+1 frei (available, Notiz leer)', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us', '2026-12-04'));
    expect(getCal).toHaveBeenCalledWith('L-FH', '2026-12-04', '2026-12-04');
    expect(setCal).toHaveBeenCalledTimes(1);
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-04', endDate: '2026-12-04', status: 'available', note: '' });
    expect(r).toEqual({ applied: true, method: 'listing-calendar', blockState: null, blockDate: null });
  });

  it('Datumsänderung: PUT true mit altem Block (X) und neuem Zieltag (Y): nichts angefasst, Warnung, set-by-us/X', async () => {
    const r = await applyNextDayBlock(tgt({ checkOutDay: '2026-12-10' }), true, prev('set-by-us', '2026-12-04'));
    expect(getCal).not.toHaveBeenCalled();
    expect(setCal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(r).toEqual({
      applied: false, method: 'none',
      reason: 'Folgetag-Block liegt auf 2026-12-04 (Reservierung verschoben) — nicht angefasst',
      blockState: 'set-by-us', blockDate: '2026-12-04',
    });
  });

  it('Datumsänderung: DELETE/PUT false gibt den alten Tag X frei, nicht den neuen', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    const r = await applyNextDayBlock(tgt({ checkOutDay: '2026-12-10' }), false, prev('set-by-us', '2026-12-04'));
    expect(getCal).toHaveBeenCalledWith('L-FH', '2026-12-04', '2026-12-04');
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-04', endDate: '2026-12-04', status: 'available', note: '' });
    expect(r).toMatchObject({ applied: true, blockState: null, blockDate: null });
  });

  it('set-by-us ohne gespeichertes block_date (Altbestand): Rücknahme nimmt Check-out+1', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    await applyNextDayBlock(tgt(), false, prev('set-by-us', null));
    expect(setCal).toHaveBeenCalledWith('L-FH', expect.objectContaining({ startDate: '2026-12-04', endDate: '2026-12-04' }));
  });

  it('Rücknahme-Fehler: blockDate bleibt der bisherige Tag', async () => {
    getCal.mockResolvedValue([day(OURS)]);
    setCal.mockRejectedValueOnce(new Error('boom'));
    const r = await applyNextDayBlock(tgt(), false, prev('set-by-us', '2026-12-04'));
    expect(r).toMatchObject({ blockState: 'set-by-us', blockDate: '2026-12-04' });
  });
});
