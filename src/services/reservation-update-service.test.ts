// #792: PATCH /api/agent/reservations/:id — Validierung, Guards, Reihenfolge, Response-Shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: {
    getReservation: vi.fn(),
    updateReservationDates: vi.fn().mockResolvedValue({}),
    updateReservationGuests: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../repositories/reservation-repository.js', () => ({
  upsertReservation: vi.fn(),
}));
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn((id: string) => (id === 'listing-avow' ? { id, accommodates: 12 } : null)),
}));
vi.mock('../config/properties.js', () => ({
  getPropertyBySlug: vi.fn(),
  getPropertyByGuestyId: vi.fn(),
}));

import { guestyClient } from './guesty-client.js';
import { upsertReservation } from '../repositories/reservation-repository.js';
import { updateReservation, toReservationView, UPDATE_ALLOWED_FIELDS } from './reservation-update-service.js';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors.js';

const getReservation = guestyClient.getReservation as any;
const updateDates = guestyClient.updateReservationDates as any;
const updateGuests = guestyClient.updateReservationGuests as any;

const before = {
  _id: 'res-1', status: 'confirmed', source: 'manual', listingId: 'listing-avow',
  checkInDateLocalized: '2026-12-01', checkOutDateLocalized: '2026-12-03', guestsCount: 4, guestId: 'g1',
  plannedArrival: '15:00', plannedDeparture: '11:00',
};
const after = {
  ...before, checkInDateLocalized: '2026-11-30', checkOutDateLocalized: '2026-12-02', guestsCount: 6,
  guest: { _id: 'g1', fullName: 'AVOW GmbH' },
  money: { currency: 'EUR', hostPayout: 3456.1, subTotalPrice: 3000, totalTaxes: 456.1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  // 1. Aufruf: Zustand vor der Änderung (Guards), 2. Aufruf: frischer Stand nach der Änderung
  getReservation.mockResolvedValueOnce(before).mockResolvedValue(after);
});

describe('Validierung', () => {
  it('leerer Body -> 400 mit Liste erlaubter Felder, kein Guesty-Zugriff', async () => {
    const p = updateReservation('res-1', {});
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await expect(updateReservation('res-1', {})).rejects.toThrow(UPDATE_ALLOWED_FIELDS.join(', '));
    expect(getReservation).not.toHaveBeenCalled();
  });

  it('unbekannte Felder -> 400 mit Liste erlaubter Felder', async () => {
    await expect(updateReservation('res-1', { price: 5 })).rejects.toThrow(/Unbekannte Felder: price.*erlaubt: checkIn/);
    await expect(updateReservation('res-1', null)).rejects.toBeInstanceOf(ValidationError);
    await expect(updateReservation('res-1', [])).rejects.toBeInstanceOf(ValidationError);
    expect(updateDates).not.toHaveBeenCalled();
  });

  it.each([
    [{ checkIn: '30.11.2026' }],
    [{ checkOut: '2026-12-2' }],
    [{ plannedArrival: '9:00' }],
    [{ plannedDeparture: '24:00' }],
    [{ plannedArrival: '12:60' }],
    [{ guestsCount: 0 }],
    [{ guestsCount: 2.5 }],
    [{ guestsCount: '6' }],
    [{ lateCheckOut: { blockDay: 'ja' } }],
    [{ lateCheckOut: {} }],
    [{ earlyCheckIn: { blockDay: true, addAdditionalFee: 'x' } }],
    [{ earlyCheckIn: { blockDay: true, extra: 1 } }],
  ])('ungültige Eingabe %j -> ValidationError', async (body) => {
    await expect(updateReservation('res-1', body)).rejects.toBeInstanceOf(ValidationError);
    expect(updateDates).not.toHaveBeenCalled();
    expect(updateGuests).not.toHaveBeenCalled();
  });

  it('checkOut <= checkIn im Body -> ValidationError', async () => {
    await expect(updateReservation('res-1', { checkIn: '2026-12-02', checkOut: '2026-12-02' }))
      .rejects.toThrow(/checkOut must be after checkIn/);
  });

  it('nur checkIn geliefert: gegen bestehendes checkOut prüfen', async () => {
    await expect(updateReservation('res-1', { checkIn: '2026-12-03' })).rejects.toThrow(/checkOut must be after checkIn/);
    expect(updateDates).not.toHaveBeenCalled();
  });

  it('guestsCount über Property-Max (accommodates) -> ValidationError', async () => {
    await expect(updateReservation('res-1', { guestsCount: 13 })).rejects.toThrow(/maximum 12/);
    expect(updateGuests).not.toHaveBeenCalled();
  });

  it('guestsCount = Max ist ok', async () => {
    await updateReservation('res-1', { guestsCount: 12 });
    expect(updateGuests).toHaveBeenCalledWith('res-1', { guestsCount: 12 });
  });
});

describe('Guards', () => {
  it.each(['inquiry', 'canceled', 'closed', 'checked_in', 'declined', 'expired'])(
    'Status %s -> ConflictError, keine Mutation', async (status) => {
      getReservation.mockReset().mockResolvedValue({ ...before, status });
      await expect(updateReservation('res-1', { guestsCount: 5 })).rejects.toBeInstanceOf(ConflictError);
      expect(updateDates).not.toHaveBeenCalled();
      expect(updateGuests).not.toHaveBeenCalled();
    });

  it('Status reserved und confirmed sind erlaubt', async () => {
    getReservation.mockReset().mockResolvedValue({ ...before, status: 'reserved' });
    await updateReservation('res-1', { guestsCount: 5 });
    expect(updateGuests).toHaveBeenCalledTimes(1);
  });

  it.each(['airbnb2', 'booking', 'Booking.com', 'airbnb', 'expedia', null, undefined])(
    'Nicht-Direkt-Quelle %s -> ConflictError „im Ursprungskanal ändern"', async (source) => {
      getReservation.mockReset().mockResolvedValue({ ...before, source });
      await expect(updateReservation('res-1', { guestsCount: 5 })).rejects.toThrow(/Ursprungskanal/);
      expect(updateGuests).not.toHaveBeenCalled();
    });

  it.each(['manual', 'direct', 'Direct', 'MANUAL'])('Direkt-Quelle %s ist erlaubt', async (source) => {
    getReservation.mockReset().mockResolvedValueOnce({ ...before, source }).mockResolvedValue(after);
    await updateReservation('res-1', { guestsCount: 5 });
    expect(updateGuests).toHaveBeenCalledTimes(1);
  });

  it('nicht lesbare/fehlende Reservierung -> Fehler der Guesty-Abfrage wird durchgereicht', async () => {
    getReservation.mockReset().mockRejectedValue(new NotFoundError('weg'));
    await expect(updateReservation('res-x', { guestsCount: 5 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Guesty-Aufrufe', () => {
  it('nur Datums-Felder -> nur Dates-Call, Mapping auf *Localized', async () => {
    await updateReservation('res-1', { checkIn: '2026-11-30', checkOut: '2026-12-02', plannedArrival: '14:00', plannedDeparture: '10:00' });
    expect(updateDates).toHaveBeenCalledWith('res-1', {
      checkInDateLocalized: '2026-11-30', checkOutDateLocalized: '2026-12-02',
      plannedArrival: '14:00', plannedDeparture: '10:00',
    });
    expect(updateGuests).not.toHaveBeenCalled();
  });

  it('nur guestsCount -> nur Guests-Call', async () => {
    await updateReservation('res-1', { guestsCount: 6 });
    expect(updateGuests).toHaveBeenCalledWith('res-1', { guestsCount: 6 });
    expect(updateDates).not.toHaveBeenCalled();
  });

  it('Dates UND Guests -> erst Dates, dann Guests', async () => {
    const order: string[] = [];
    updateDates.mockImplementation(async () => { order.push('dates'); return {}; });
    updateGuests.mockImplementation(async () => { order.push('guests'); return {}; });
    await updateReservation('res-1', { checkIn: '2026-11-30', checkOut: '2026-12-02', guestsCount: 6 });
    expect(order).toEqual(['dates', 'guests']);
  });

  it('Dates-Call scheitert -> Guests-Call wird nicht mehr ausgeführt', async () => {
    updateDates.mockRejectedValueOnce(new Error('Guesty 400'));
    await expect(updateReservation('res-1', { checkIn: '2026-11-30', checkOut: '2026-12-02', guestsCount: 6 })).rejects.toThrow('Guesty 400');
    expect(updateGuests).not.toHaveBeenCalled();
  });

  it('lateCheckOut/earlyCheckIn: addAdditionalFee default false', async () => {
    await updateReservation('res-1', { lateCheckOut: { blockDay: true }, earlyCheckIn: { blockDay: false, addAdditionalFee: true } });
    expect(updateDates).toHaveBeenCalledWith('res-1', {
      lateCheckOut: { blockDay: true, addAdditionalFee: false },
      earlyCheckIn: { blockDay: false, addAdditionalFee: true },
    });
  });
});

describe('Ergebnis', () => {
  it('Response = GET-Shape plus actualTotal, lokal gespiegelt', async () => {
    const r = await updateReservation('res-1', { checkIn: '2026-11-30', checkOut: '2026-12-02', guestsCount: 6 });
    expect(r).toEqual({
      id: 'res-1', status: 'confirmed',
      checkIn: '2026-11-30', checkOut: '2026-12-02', guestsCount: 6, guestId: 'g1',
      plannedArrival: '15:00', plannedDeparture: '11:00', source: 'manual',
      actualTotal: 3456.1,
    });
    expect(upsertReservation).toHaveBeenCalledWith(expect.objectContaining({
      reservation_id: 'res-1', listing_id: 'listing-avow',
      check_in_localized: '2026-11-30', check_out_localized: '2026-12-02', guests_count: 6,
      planned_arrival: '15:00', planned_departure: '11:00', source: 'manual',
    }));
  });

  it('lokales Spiegeln schlägt fehl -> Antwort trotzdem erfolgreich (Guesty ist durch)', async () => {
    (upsertReservation as any).mockImplementationOnce(() => { throw new Error('db'); });
    const r = await updateReservation('res-1', { guestsCount: 6 });
    expect(r.id).toBe('res-1');
  });
});

describe('toReservationView', () => {
  it('liefert null-Defaults', () => {
    expect(toReservationView({}, 'x')).toEqual({
      id: 'x', status: null, checkIn: null, checkOut: null, guestsCount: null, guestId: null,
      plannedArrival: null, plannedDeparture: null, source: null,
    });
  });
});
