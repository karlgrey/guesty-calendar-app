import { describe, it, expect, vi } from 'vitest';
import { GuestyClient } from './guesty-client.js';

function clientWithMockedRequest(result: any) {
  const client = new GuestyClient();
  const spy = vi.spyOn(client as any, 'request').mockResolvedValue(result);
  return { client, spy };
}

describe('GuestyClient writes', () => {
  it('createGuest POSTet an /guests-crud und liefert die ID', async () => {
    const { client, spy } = clientWithMockedRequest({ _id: 'guest-1' });
    const id = await client.createGuest({
      firstName: 'calimoto GmbH', lastName: 'Sebastian Dambeck', email: 's@x.de', phone: '+49 170 000',
      address: { street: 'Babelsberger Str. 12', city: 'Potsdam', zipcode: '14473', country: 'Germany' },
    });
    expect(id).toBe('guest-1');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/guests-crud');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      firstName: 'calimoto GmbH', lastName: 'Sebastian Dambeck', email: 's@x.de', phones: ['+49 170 000'],
      address: { street: 'Babelsberger Str. 12', city: 'Potsdam', zipcode: '14473', country: 'Germany' },
    });
  });

  it('createReservation POSTet an /reservations-v3 mit reservedUntil -1 und Preis-Override', async () => {
    const { client, spy } = clientWithMockedRequest({ reservationId: 'res-1' });
    const id = await client.createReservation({
      listingId: 'listing-1', checkIn: '2026-09-09', checkOut: '2026-09-10',
      guestsCount: 15, guestId: 'guest-1', status: 'reserved', accommodationFare: 2850,
    });
    expect(id).toBe('res-1');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      listingId: 'listing-1',
      checkInDateLocalized: '2026-09-09',
      checkOutDateLocalized: '2026-09-10',
      guestsCount: 15,
      guestId: 'guest-1',
      status: 'reserved',
      source: 'manual',
      reservedUntil: -1,
      accommodationFare: 2850,
    });
    expect(body).not.toHaveProperty('cleaningFee');
  });

  it('createReservation lässt accommodationFare weg, wenn kein Preis übergeben', async () => {
    const { client, spy } = clientWithMockedRequest({ reservationId: 'res-2' });
    await client.createReservation({
      listingId: 'l', checkIn: '2026-09-09', checkOut: '2026-09-10',
      guestsCount: 2, guestId: 'g', status: 'reserved',
    });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('accommodationFare');
  });

  it('updateGuest PUTtet an /guests-crud/{id} (Adresse + phones-Mapping)', async () => {
    const { client, spy } = clientWithMockedRequest({ ok: true });
    await client.updateGuest('guest-1', { phone: '+49 1', address: { city: 'Potsdam' } });
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/guests-crud/guest-1');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ phones: ['+49 1'], address: { city: 'Potsdam' } });
  });

  it('updateReservationStatus PUTtet an /reservations-v3/{id}/status', async () => {
    const { client, spy } = clientWithMockedRequest({ ok: true });
    await client.updateReservationStatus('res-1', 'canceled');
    const [endpoint, options] = spy.mock.calls[0];
    expect(endpoint).toBe('/reservations-v3/res-1/status');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ status: 'canceled', cancellationReason: 'Cancelled Due to Hold/Expiration' });
  });
});
