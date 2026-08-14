import { describe, it, expect } from 'vitest';
import { extractReservationFromCalendar } from './reservation-mapper.js';
import type { GuestyCalendarDay } from '../types/guesty.js';

/**
 * Guesty bettet bei manuell/per Open API angelegten Reservierungen (source
 * 'manual') in den Kalender-blockRefs ein Reservierungsobjekt OHNE
 * nightsCount/guestsCount ein — Channel-Buchungen liefern beide Felder.
 * Fall Anna/Netlight/Calimoto 14.08.2026: ETL überschrieb die korrekten
 * lokalen Werte mit 0/NULL („0 Gäste, 0 Nächte" im Google-Kalender-Event).
 */
function dayWithReservation(res: Record<string, unknown>): GuestyCalendarDay {
  return {
    date: '2026-09-09',
    status: 'booked',
    blockRefs: [{ reservation: res }],
  } as unknown as GuestyCalendarDay;
}

const baseRes = {
  _id: 'res-manual-1',
  listingId: 'listing-1',
  status: 'confirmed',
  checkIn: '2026-09-09T08:00:00+00:00',
  checkOut: '2026-09-12T12:00:00+00:00',
  checkInDateLocalized: '2026-09-09',
  checkOutDateLocalized: '2026-09-12',
  guest: { fullName: 'Anna Lindvall' },
};

describe('extractReservationFromCalendar', () => {
  it('leitet nights_count aus den Daten ab, wenn Guesty kein nightsCount liefert (manual-Reservierung)', () => {
    const mapped = extractReservationFromCalendar(dayWithReservation(baseRes), '2026-08-14T00:00:00Z');
    expect(mapped).not.toBeNull();
    expect(mapped!.nights_count).toBe(3);
  });

  it('fällt ohne localized-Daten auf die ISO-Datumsteile zurück', () => {
    const res = { ...baseRes, checkInDateLocalized: undefined, checkOutDateLocalized: undefined };
    const mapped = extractReservationFromCalendar(dayWithReservation(res), '2026-08-14T00:00:00Z');
    expect(mapped!.nights_count).toBe(3);
  });

  it('übernimmt vorhandenes nightsCount/guestsCount unverändert', () => {
    const res = { ...baseRes, nightsCount: 2, guestsCount: 15 };
    const mapped = extractReservationFromCalendar(dayWithReservation(res), '2026-08-14T00:00:00Z');
    expect(mapped!.nights_count).toBe(2);
    expect(mapped!.guests_count).toBe(15);
  });

  it('lässt guests_count null, wenn Guesty nichts liefert (Upsert bewahrt dann den Bestand)', () => {
    const mapped = extractReservationFromCalendar(dayWithReservation(baseRes), '2026-08-14T00:00:00Z');
    expect(mapped!.guests_count).toBeNull();
  });
});
