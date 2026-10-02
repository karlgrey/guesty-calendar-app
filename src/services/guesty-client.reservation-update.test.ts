// #792: PUT /reservations-v3/:id/dates und /guests (Guesty-Doku verifiziert 02.10.2026).
import { describe, it, expect, vi } from 'vitest';
import { GuestyClient } from './guesty-client.js';

function clientWithMockedRequest(result: any = {}) {
  const client = new GuestyClient();
  const spy = vi.spyOn(client as any, 'request').mockResolvedValue(result);
  return { client, spy };
}

describe('GuestyClient.updateReservationDates', () => {
  it('PUTet nur die übergebenen Felder an /reservations-v3/:id/dates', async () => {
    const { client, spy } = clientWithMockedRequest({ reservationId: 'r1' });
    await client.updateReservationDates('r1', {
      checkInDateLocalized: '2026-11-30',
      checkOutDateLocalized: '2026-12-02',
      lateCheckOut: { blockDay: true, addAdditionalFee: false },
    });
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3/r1/dates');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      checkInDateLocalized: '2026-11-30',
      checkOutDateLocalized: '2026-12-02',
      lateCheckOut: { blockDay: true, addAdditionalFee: false },
    });
  });

  it('reicht plannedArrival/-Departure, earlyCheckIn und ignore*-Flags durch', async () => {
    const { client, spy } = clientWithMockedRequest();
    await client.updateReservationDates('r1', {
      plannedArrival: '14:00', plannedDeparture: '12:00',
      earlyCheckIn: { blockDay: false, addAdditionalFee: true },
      ignoreCalendar: true, applyRecalculation: false,
    });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({
      plannedArrival: '14:00', plannedDeparture: '12:00',
      earlyCheckIn: { blockDay: false, addAdditionalFee: true },
      ignoreCalendar: true, applyRecalculation: false,
    });
  });

  it('liefert die Guesty-Antwort zurück', async () => {
    const { client } = clientWithMockedRequest({ reservationId: 'r1', money: { guestTotalPrice: 1 } });
    expect(await client.updateReservationDates('r1', { plannedArrival: '15:00' }))
      .toMatchObject({ reservationId: 'r1' });
  });
});

describe('GuestyClient.updateReservationGuests', () => {
  it('PUTet guestsCount an /reservations-v3/:id/guests', async () => {
    const { client, spy } = clientWithMockedRequest({ reservationId: 'r1', guestsCount: 6 });
    await client.updateReservationGuests('r1', { guestsCount: 6 });
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3/r1/guests');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ guestsCount: 6 });
  });

  it('reicht numberOfGuests durch', async () => {
    const { client, spy } = clientWithMockedRequest();
    await client.updateReservationGuests('r1', { guestsCount: 6, numberOfGuests: { numberOfAdults: 5, numberOfChildren: 1 } });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({
      guestsCount: 6, numberOfGuests: { numberOfAdults: 5, numberOfChildren: 1 },
    });
  });
});

// #799: Listing-Kalender schreiben (Folgetag-Block bei Kanalbuchungen)
describe('GuestyClient.setListingCalendarStatus', () => {
  it('PUTet {startDate,endDate,status,note} an den Listing-Kalender', async () => {
    const { client, spy } = clientWithMockedRequest({ status: 200 });
    await client.setListingCalendarStatus('L1', { startDate: '2026-12-03', endDate: '2026-12-03', status: 'unavailable', note: 'Late-Checkout r1' });
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/availability-pricing/api/calendar/listings/L1');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ startDate: '2026-12-03', endDate: '2026-12-03', status: 'unavailable', note: 'Late-Checkout r1' });
  });

  it('ohne note wird kein note-Feld gesendet; leerer String bleibt (Notiz löschen)', async () => {
    const { client, spy } = clientWithMockedRequest();
    await client.setListingCalendarStatus('L1', { startDate: '2026-12-03', endDate: '2026-12-03', status: 'available' });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ startDate: '2026-12-03', endDate: '2026-12-03', status: 'available' });
    await client.setListingCalendarStatus('L1', { startDate: '2026-12-03', endDate: '2026-12-03', status: 'available', note: '' });
    expect(JSON.parse(spy.mock.calls[1][1].body).note).toBe('');
  });
});
