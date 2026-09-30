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

const getDocumentByIdMock = vi.fn();
vi.mock('../repositories/document-repository.js', () => ({
  getDocumentById: (...args: unknown[]) => getDocumentByIdMock(...args),
}));

const { formatCheckInOutText, documentToTemplateData, formatStoredDateGerman } = await import('./pdf-generator.js');

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

describe('documentToTemplateData — isPastStay (#716)', () => {
  beforeEach(() => {
    getReservationByIdMock.mockReset();
    getPropertyByGuestyIdMock.mockReset();
    getReservationByIdMock.mockReturnValue(null);
  });

  const now = new Date('2026-09-25T10:00:00.000Z'); // 25.09. 12:00 in Berlin

  it('ist true, wenn der Check-out gestern war', () => {
    const data = documentToTemplateData(baseDocument({ checkOut: '2026-09-24' }), now);
    expect(data.isPastStay).toBe(true);
  });

  it('ist false, wenn der Check-out heute ist', () => {
    const data = documentToTemplateData(baseDocument({ checkOut: '2026-09-25' }), now);
    expect(data.isPastStay).toBe(false);
  });

  it('ist false, wenn der Check-out morgen ist', () => {
    const data = documentToTemplateData(baseDocument({ checkOut: '2026-09-26' }), now);
    expect(data.isPastStay).toBe(false);
  });

  it('nutzt den Berliner Kalendertag von heute (22:30Z ist bereits der Folgetag in Berlin)', () => {
    const lateNow = new Date('2026-09-25T22:30:00.000Z'); // 26.09. 00:30 in Berlin
    const data = documentToTemplateData(baseDocument({ checkOut: '2026-09-25' }), lateNow);
    expect(data.isPastStay).toBe(true);
  });

  it('nutzt den Berliner Kalendertag des Check-outs (ISO-Zeitpunkt kurz nach Berliner Mitternacht)', () => {
    // 24.09. 22:30Z = 25.09. 00:30 Berlin → Check-out heute, nicht vergangen
    const data = documentToTemplateData(baseDocument({ checkOut: '2026-09-24T22:30:00.000Z' }), now);
    expect(data.isPastStay).toBe(false);
  });

  it('verwendet now auch für dateFormatted', () => {
    const data = documentToTemplateData(baseDocument(), now);
    expect(data.dateFormatted).toBe('25.09.2026');
  });
});

describe('documentToTemplateData — Storno-Beleg (#771)', () => {
  beforeEach(() => {
    getReservationByIdMock.mockReset();
    getDocumentByIdMock.mockReset();
  });

  it('verweist auf Nummer und Datum der stornierten Rechnung, Belegdatum = Erstellung', () => {
    getDocumentByIdMock.mockReturnValue(baseDocument({ id: 114, documentNumber: '2026-0035', createdAt: '2026-09-22 08:15:00' }));
    const data = documentToTemplateData(
      baseDocument({
        id: 115, documentType: 'cancellation', documentNumber: '2026-0036', cancelsDocumentId: 114,
        total: -21400, subtotal: -20000, taxAmount: -1400, discountTotal: 500,
        createdAt: '2026-09-30 13:00:00',
      }),
      new Date('2026-12-24T10:00:00Z'),
    );
    expect(getDocumentByIdMock).toHaveBeenCalledWith(114);
    expect(data.isCancellation).toBe(true);
    expect(data.cancelsDocumentNumber).toBe('2026-0035');
    expect(data.cancelsDocumentDateFormatted).toBe('22.09.2026');
    expect(data.dateFormatted).toBe('30.09.2026');
    expect(data.totalFormatted).toBe('-214,00');
    expect(data.servicePeriodFormatted).toBe('01.09.2026 - 03.09.2026');
    expect(data.hasDiscount).toBe(true);
  });

  it('Rechnung: kein Storno-Verweis, kein DB-Lookup', () => {
    const data = documentToTemplateData(baseDocument());
    expect(data.isCancellation).toBe(false);
    expect(data.cancelsDocumentNumber).toBeUndefined();
    expect(getDocumentByIdMock).not.toHaveBeenCalled();
  });
});

describe('formatStoredDateGerman (#771)', () => {
  it('liest SQLite-UTC als Berliner Kalendertag (23:30 UTC = Folgetag)', () => {
    expect(formatStoredDateGerman('2026-09-21 23:30:00')).toBe('22.09.2026');
  });
  it('akzeptiert ISO mit Zone', () => {
    expect(formatStoredDateGerman('2026-09-22T08:00:00.000Z')).toBe('22.09.2026');
  });
});
