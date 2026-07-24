import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: {
    createGuest: vi.fn().mockResolvedValue('guest-1'),
    createReservation: vi.fn().mockResolvedValue('res-1'),
    updateReservationStatus: vi.fn().mockResolvedValue(undefined),
    getReservation: vi.fn().mockResolvedValue({ status: 'reserved', confirmationCode: 'GY-TEST', money: { currency: 'EUR', subTotalPrice: 2850 } }),
    getQuote: vi.fn().mockResolvedValue({ fareCleaning: 349.9, totalTaxes: 0, subTotalPrice: 1200, fareAccommodation: 1000, fareAccommodationAdjusted: 1000 }),
  },
}));
vi.mock('../repositories/availability-repository.js', () => ({
  areDatesAvailable: vi.fn().mockReturnValue(true),
}));
vi.mock('../repositories/reservation-repository.js', () => ({
  upsertReservation: vi.fn(),
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
import { upsertReservation } from '../repositories/reservation-repository.js';
import { createOrGetDocument } from './document-service.js';
import { createOfferReservation, confirmOfferReservation, releaseOfferReservation } from './reservation-service.js';
import { ConflictError, ValidationError } from '../utils/errors.js';

const baseInput = {
  propertySlug: 'farmhouse',
  checkIn: '2026-09-09',
  checkOut: '2026-09-10',
  guestsCount: 15,
  guest: { firstName: 'Nina', lastName: 'Lattke', email: 'n@x.de' },
  totalGross: 2850,
};

beforeEach(() => {
  vi.clearAllMocks();
  (areDatesAvailable as any).mockReturnValue(true);
  (upsertReservation as any).mockImplementation(() => undefined);
  (createOrGetDocument as any).mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('pdf'), isNew: true,
  });
  (guestyClient.getReservation as any).mockResolvedValue({ status: 'reserved', confirmationCode: 'GY-TEST', money: { currency: 'EUR', subTotalPrice: 2850 } });
});

describe('createOfferReservation', () => {
  it('spiegelt die Reservierung lokal, BEVOR das Dokument entsteht (documents-FK)', async () => {
    const order: string[] = [];
    (upsertReservation as any).mockImplementation(() => order.push('mirror'));
    (createOrGetDocument as any).mockImplementation(async () => {
      order.push('document');
      return { document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('pdf'), isNew: true };
    });
    await createOfferReservation({ ...baseInput });
    expect(order).toEqual(['mirror', 'document']);
    expect(upsertReservation).toHaveBeenCalledWith(expect.objectContaining({
      reservation_id: 'res-1', listing_id: 'listing-fh', status: 'reserved', guest_name: 'Nina Lattke',
    }));
  });

  it('Spiegel-Fehler landet als documentError, Reservierung bleibt', async () => {
    (upsertReservation as any).mockImplementation(() => { throw new Error('db kaputt'); });
    const r = await createOfferReservation({ ...baseInput });
    expect(r.reservationId).toBe('res-1');
    expect(r.documentError).toMatch(/db kaputt/);
    expect(createOrGetDocument).not.toHaveBeenCalled();
  });

  it('legt Gast + Hold an und erzeugt das Angebot', async () => {
    const r = await createOfferReservation({ ...baseInput });
    expect(guestyClient.createGuest).toHaveBeenCalledOnce();
    // Rückwärtsrechnung: 2850 Ziel − 349,90 Reinigung − 0 Steuern = 2500,10
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.objectContaining({
      listingId: 'listing-fh', status: 'reserved', accommodationFare: 2500.1,
    }));
    expect(createOrGetDocument).toHaveBeenCalledWith({ reservationId: 'res-1', documentType: 'quote' });
    expect(r).toMatchObject({ reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042', priceSource: 'manual' });
  });

  it('409 bei belegtem Zeitraum — KEIN Guesty-Call', async () => {
    (areDatesAvailable as any).mockReturnValue(false);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(ConflictError);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(/not available|belegt/i);
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('validiert: unbekanntes Objekt, Nicht-Guesty-Objekt, checkOut<=checkIn, guestsCount<1, Preis<=0', async () => {
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'nope' })).rejects.toThrow(ValidationError);
    await expect(createOfferReservation({ ...baseInput, propertySlug: 'firenze-loft' })).rejects.toThrow(ValidationError);
    await expect(createOfferReservation({ ...baseInput, checkOut: '2026-09-09' })).rejects.toThrow(ValidationError);
    await expect(createOfferReservation({ ...baseInput, guestsCount: 0 })).rejects.toThrow(ValidationError);
    await expect(createOfferReservation({ ...baseInput, totalGross: -1 })).rejects.toThrow(ValidationError);
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('Rückwärtsrechnung mit USt: Satz aus Quote, fare = total/(1+r) − Reinigung', async () => {
    (guestyClient.getQuote as any).mockResolvedValueOnce({ fareCleaning: 350, totalTaxes: 213.5, subTotalPrice: 3050, fareAccommodation: 3000, fareAccommodationAdjusted: 2700 });
    await createOfferReservation({ ...baseInput, totalGross: 3263.5 });
    // 3263.5/1.07 = 3050 → −350 Reinigung = 2700 → /0.9 LOS-Faktor = 3000
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.objectContaining({ accommodationFare: 3000 }));
  });

  it('totalGross unter Reinigung+USt → ValidationError, kein Guesty-Write', async () => {
    (guestyClient.getQuote as any).mockResolvedValueOnce({ fareCleaning: 349.9, totalTaxes: 0, subTotalPrice: 1200, fareAccommodation: 1000, fareAccommodationAdjusted: 1000 });
    await expect(createOfferReservation({ ...baseInput, totalGross: 300 })).rejects.toThrow(ValidationError);
    expect(guestyClient.createGuest).not.toHaveBeenCalled();
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
  });

  it('createGuest schlägt fehl → Fehler propagiert unverändert, KEIN Dokument, KEINE Reservierung', async () => {
    const err = new Error('Guesty down');
    (guestyClient.createGuest as any).mockRejectedValueOnce(err);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(err);
    expect(guestyClient.createReservation).not.toHaveBeenCalled();
    expect(createOrGetDocument).not.toHaveBeenCalled();
  });

  it('createReservation schlägt fehl → Fehler propagiert unverändert, KEIN Dokument, KEIN Status-Update', async () => {
    const err = new Error('Guesty reservations-v3 down');
    (guestyClient.createReservation as any).mockRejectedValueOnce(err);
    await expect(createOfferReservation({ ...baseInput })).rejects.toThrow(err);
    expect(createOrGetDocument).not.toHaveBeenCalled();
    expect(guestyClient.updateReservationStatus).not.toHaveBeenCalled();
  });

  it('ohne totalGross: kein Override, keine Quote nötig, priceSource=quote', async () => {
    const { totalGross: _p, ...noPrice } = baseInput;
    const r = await createOfferReservation(noPrice as any);
    expect(guestyClient.createReservation).toHaveBeenCalledWith(expect.not.objectContaining({ accommodationFare: expect.anything() }));
    expect(r.priceSource).toBe('quote');
    expect(guestyClient.getQuote).not.toHaveBeenCalled();
  });

  it('holdUntil Default = heute + 7 Tage', async () => {
    const r = await createOfferReservation({ ...baseInput });
    const expected = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  it('release setzt Status expired (Holds sind nicht cancelbar)', async () => {
    await releaseOfferReservation('res-1');
    expect(guestyClient.updateReservationStatus).toHaveBeenCalledWith('res-1', 'expired');
  });
});
