import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Document } from '../repositories/document-repository.js';

const getReservationByIdMock = vi.fn();
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationById: (...args: unknown[]) => getReservationByIdMock(...args),
}));

const getPropertyByGuestyIdMock = vi.fn();
vi.mock('../config/properties.js', () => ({
  getPropertyByGuestyId: (...args: unknown[]) => getPropertyByGuestyIdMock(...args),
}));

const { formatCheckInOutText, documentToTemplateData } = await import('./pdf-generator.js');

function baseDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 1,
    documentType: 'invoice',
    documentNumber: '2026-0099',
    reservationId: 'res-farmhouse-1',
    customer: { name: 'Anna Beispiel', company: null, street: null, city: null, zip: null, country: null },
    checkIn: '2026-09-01',
    checkOut: '2026-09-03',
    nights: 2,
    guestsCount: 2,
    guestsIncluded: 5,
    currency: 'EUR',
    source: 'Direct',
    accommodationTotal: 20000,
    accommodationRate: 10000,
    extraGuestTotal: 0,
    extraGuestRate: 0,
    extraGuestNights: 0,
    cleaningFee: 0,
    discountTotal: 0,
    subtotal: 20000,
    taxRate: 7,
    taxAmount: 1400,
    total: 21400,
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
    ...overrides,
  };
}

describe('formatCheckInOutText', () => {
  it('formatiert volle Stunden ohne führende Null und ohne Minuten (Farmhouse: 08:00/12:00)', () => {
    expect(formatCheckInOutText('08:00', '12:00')).toBe('Check-in ab 8 Uhr, Checkout bis 12 Uhr.');
  });

  it('behält Minuten, wenn die Zeit nicht auf die volle Stunde fällt', () => {
    expect(formatCheckInOutText('15:30', '11:00')).toBe('Check-in ab 15:30 Uhr, Checkout bis 11 Uhr.');
  });

  it('gibt undefined zurück, wenn eine der beiden Zeiten fehlt (nichts erfinden)', () => {
    expect(formatCheckInOutText(undefined, '12:00')).toBeUndefined();
    expect(formatCheckInOutText('08:00', undefined)).toBeUndefined();
    expect(formatCheckInOutText(undefined, undefined)).toBeUndefined();
  });
});

describe('documentToTemplateData — checkInOutText', () => {
  beforeEach(() => {
    getReservationByIdMock.mockReset();
    getPropertyByGuestyIdMock.mockReset();
  });

  it('setzt checkInOutText aus der Property-Konfiguration der Reservierung (Farmhouse)', () => {
    getReservationByIdMock.mockReturnValue({ listing_id: 'guesty-farmhouse' });
    getPropertyByGuestyIdMock.mockReturnValue({ checkInTime: '08:00', checkOutTime: '12:00' });

    const data = documentToTemplateData(baseDocument());

    expect(data.checkInOutText).toBe('Check-in ab 8 Uhr, Checkout bis 12 Uhr.');
    expect(getPropertyByGuestyIdMock).toHaveBeenCalledWith('guesty-farmhouse');
  });

  it('lässt checkInOutText weg, wenn die Property keine Zeiten hinterlegt hat', () => {
    getReservationByIdMock.mockReturnValue({ listing_id: 'guesty-u19' });
    getPropertyByGuestyIdMock.mockReturnValue({ checkInTime: undefined, checkOutTime: undefined });

    const data = documentToTemplateData(baseDocument({ reservationId: 'res-u19-1' }));

    expect(data.checkInOutText).toBeUndefined();
  });

  it('lässt checkInOutText weg, wenn die Reservierung lokal nicht (mehr) bekannt ist', () => {
    getReservationByIdMock.mockReturnValue(null);

    const data = documentToTemplateData(baseDocument({ reservationId: 'res-farmhouse-alt' }));

    expect(data.checkInOutText).toBeUndefined();
    expect(getPropertyByGuestyIdMock).not.toHaveBeenCalled();
  });
});
