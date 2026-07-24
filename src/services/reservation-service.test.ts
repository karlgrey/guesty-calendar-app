import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: {
    createGuest: vi.fn().mockResolvedValue('guest-1'),
    createReservation: vi.fn().mockResolvedValue('res-1'),
    updateReservationStatus: vi.fn().mockResolvedValue(undefined),
    getQuote: vi.fn().mockResolvedValue({ money: { totalPrice: 1200 } }),
  },
}));
vi.mock('../repositories/availability-repository.js', () => ({
  areDatesAvailable: vi.fn().mockReturnValue(true),
}));
vi.mock('./document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('pdf'), isNew: true,
  }),
}));
vi.mock('../config/properties.js', () => ({
  getPropertyBySlug: vi.fn((slug: string) =>
    slug === 'farmhouse'
      ? { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'listing-fh' }
      : slug === 'firenze-loft'
        ? { slug: 'firenze-loft', provider: 'airbnb-mail' }
        : undefined),
}));

import { guestyClient } from './guesty-client.js';
import { areDatesAvailable } from '../repositories/availability-repository.js';
import { createOrGetDocument } from './document-service.js';
import { createOfferReservation, confirmOfferReservation, releaseOfferReservation } from './reservation-service.js';

const baseInput = {
  propertySlug: 'farmhouse',
  checkIn: '2026-09-09',
  checkOut: '2026-09-10',
  guestsCount: 15,
  guest: { firstName: 'Nina', lastName: 'Lattke', email: 'n@x.de' },
  priceGross: 2850,
};

beforeEach(() => { vi.clearAllMocks(); (areDatesAvailable as any).mockReturnValue(true); });

describe('createOfferReservation', () => {
  it('legt Gast + Hold an und erzeugt das Angebot', async () => {
    const r = await createOfferReservation({ ...baseInput });
    expect(guestyClient.createGuest).toHaveBeenCalledOnce();
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.objectContaining({
      listingId: 'listing-fh', status: 'reserved', accommodationFare: 2850,
    }));
    expect(createOrGetDocument).toHaveBeenCalledWith({ reservationId: 'res-1', documentType: 'quote' });
    expect(r).toMatchObject({ reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042', priceSource: 'manual' });
  });

  it('409 bei belegtem Zeitraum — KEIN Guesty-Call', async () => {
    (areDatesAvailable as any).mockReturnValue(false);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(/not available|belegt/i);
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('validiert: unbekanntes Objekt, Nicht-Guesty-Objekt, checkOut<=checkIn, guestsCount<1, Preis<=0', async () => {
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'nope' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'firenze-loft' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, checkOut: '2026-09-09' })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, guestsCount: 0 })).rejects.toThrow();
    await expect(createOfferReservation({ ...baseInput, priceGross: -1 })).rejects.toThrow();
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('ohne priceGross: kein Override, priceSource=quote', async () => {
    const { priceGross: _p, ...noPrice } = baseInput;
    const r = await createOfferReservation(noPrice as any);
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.not.objectContaining({ accommodationFare: expect.anything() }));
    expect(r.priceSource).toBe('quote');
  });

  it('holdUntil Default = heute + 14 Tage', async () => {
    const r = await createOfferReservation({ ...baseInput });
    const expected = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(r.holdUntil).toBe(expected);
  });

  it('Teilfehler: Dokument schlägt fehl → Reservierung bleibt, documentError gesetzt', async () => {
    (createOrGetDocument as any).mockRejectedValue(new Error('pdf kaputt'));
    const r = await createOfferReservation({ ...baseInput });
    expect(r.reservationId).toBe('res-1');
    expect(r.documentError).toMatch(/pdf kaputt/);
    expect(guestyClient.updateReservationStatus).not.toHaveBeenCalled(); // NICHT stornieren
  });
});

describe('confirm/release', () => {
  it('confirm setzt Status confirmed', async () => {
    await confirmOfferReservation('res-1');
    expect(guestyClient.updateReservationStatus).toHaveBeenCalledWith('res-1', 'confirmed');
  });
  it('release setzt Status canceled', async () => {
    await releaseOfferReservation('res-1');
    expect(guestyClient.updateReservationStatus).toHaveBeenCalledWith('res-1', 'canceled');
  });
});
