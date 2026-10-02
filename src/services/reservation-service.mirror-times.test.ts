// #793: Der PATCH-Spiegel (mirrorReservationLocally) MUSS über den Zeit-Tracker schreiben —
// sonst sieht der ETL die Änderung nie (Spiegel hat sie dann schon abgelegt).
import { describe, it, expect, vi } from 'vitest';

const trackMock = vi.fn((rows: any[], upsert: (r: any[]) => number) => upsert(rows));
vi.mock('./reservation-times-notifier.js', () => ({
  upsertReservationsTrackingTimes: (...a: any[]) => (trackMock as any)(...a),
}));
const upsertMock = vi.fn();
vi.mock('../repositories/reservation-repository.js', () => ({
  upsertReservation: (...a: unknown[]) => upsertMock(...a),
  applyCancellationLocally: vi.fn(),
}));
vi.mock('./guesty-client.js', () => ({ guestyClient: { getReservation: vi.fn() } }));
vi.mock('./document-service.js', () => ({ createOrGetDocument: vi.fn() }));
vi.mock('../repositories/availability-repository.js', () => ({ areDatesAvailable: vi.fn() }));
vi.mock('../config/properties.js', () => ({ getPropertyBySlug: vi.fn(), getPropertyByGuestyId: vi.fn() }));

import { mirrorReservationLocally } from './reservation-service.js';

describe('mirrorReservationLocally -> Zeit-Tracker (#793)', () => {
  it('schreibt über upsertReservationsTrackingTimes und reicht planned_* durch', async () => {
    const fresh = {
      checkIn: '2026-12-01T14:00:00Z', checkOut: '2026-12-03T11:00:00Z',
      checkInDateLocalized: '2026-12-01', checkOutDateLocalized: '2026-12-03',
      status: 'confirmed', plannedArrival: '14:00', plannedDeparture: '18:00', money: {},
    };
    await mirrorReservationLocally('res-1', 'L1', {
      checkIn: '2026-12-01', checkOut: '2026-12-03', guestsCount: 2, guest: { firstName: 'A', lastName: 'B' },
    }, fresh);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      reservation_id: 'res-1', planned_arrival: '14:00', planned_departure: '18:00',
    });
  });
});
