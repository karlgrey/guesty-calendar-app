// #799: Folgetag-Block nur für Objekte mit Flag; Direkt -> updateReservation, Kanal -> Listing-Kalender
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: { setListingCalendarStatus: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./reservation-update-service.js', async (orig) => ({
  ...(await orig<typeof import('./reservation-update-service.js')>()),
  updateReservation: vi.fn().mockResolvedValue({}),
}));
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
import { ExternalApiError } from '../utils/errors.js';

const setCal = guestyClient.setListingCalendarStatus as any;
const upd = updateReservation as any;
const res = (over: Record<string, unknown> = {}) => ({
  reservationId: 'r1', listingId: 'L-FH', source: 'manual', checkOutDay: '2026-12-03', ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('applyNextDayBlock', () => {
  it('Objekt ohne Flag: kein Aufruf, method none (auch bei wanted=true)', async () => {
    for (const listingId of ['L-U19', 'L-HX', 'L-UNBEKANNT']) {
      const r = await applyNextDayBlock(res({ listingId }), true);
      expect(r).toEqual({ applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag' });
    }
    expect(upd).not.toHaveBeenCalled();
    expect(setCal).not.toHaveBeenCalled();
  });

  it('Direktbuchung: updateReservation mit lateCheckOut.blockDay', async () => {
    const r = await applyNextDayBlock(res({ source: 'manual' }), true);
    expect(r).toEqual({ applied: true, method: 'reservation' });
    expect(upd).toHaveBeenCalledWith('r1', { lateCheckOut: { blockDay: true, addAdditionalFee: false } });
    expect(setCal).not.toHaveBeenCalled();
  });

  it('Direktbuchung (source direct, Groß-/Kleinschreibung): Rücknahme blockDay false', async () => {
    const r = await applyNextDayBlock(res({ source: 'Direct' }), false);
    expect(r.applied).toBe(true);
    expect(upd).toHaveBeenCalledWith('r1', { lateCheckOut: { blockDay: false, addAdditionalFee: false } });
  });

  it('Kanalbuchung (airbnb2): Listing-Kalender unavailable am Check-out-Tag mit Notiz', async () => {
    const r = await applyNextDayBlock(res({ source: 'airbnb2' }), true);
    expect(r).toEqual({ applied: true, method: 'listing-calendar' });
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-03', endDate: '2026-12-03', status: 'unavailable', note: 'Late-Checkout r1' });
    expect(upd).not.toHaveBeenCalled();
  });

  it('Kanalbuchung: Rücknahme setzt available und löscht die Notiz', async () => {
    const r = await applyNextDayBlock(res({ source: 'airbnb2' }), false);
    expect(r).toEqual({ applied: true, method: 'listing-calendar' });
    expect(setCal).toHaveBeenCalledWith('L-FH', { startDate: '2026-12-03', endDate: '2026-12-03', status: 'available', note: '' });
  });

  it('unbekannte Quelle (null) gilt als Kanal -> Listing-Kalender', async () => {
    await applyNextDayBlock(res({ source: null }), true);
    expect(setCal).toHaveBeenCalledTimes(1);
  });

  it('Guesty-Fehler (Kanal): applied false mit reason + error-Details, wirft nicht', async () => {
    setCal.mockRejectedValueOnce(new ExternalApiError('Guesty API error', 400, 'guesty', { message: 'dates blocked' }));
    const r = await applyNextDayBlock(res({ source: 'airbnb2' }), true);
    expect(r).toMatchObject({ applied: false, method: 'listing-calendar' });
    expect(r.reason).toMatch(/Guesty/);
    expect(r.error).toEqual({ message: 'Guesty API error', details: { message: 'dates blocked' } });
  });

  it('Guesty-Fehler (Direkt): applied false, method reservation', async () => {
    upd.mockRejectedValueOnce(new Error('boom'));
    const r = await applyNextDayBlock(res({ source: 'manual' }), true);
    expect(r).toMatchObject({ applied: false, method: 'reservation' });
    expect(r.error?.message).toBe('boom');
  });
});
