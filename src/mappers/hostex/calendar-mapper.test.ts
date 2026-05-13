import { describe, it, expect } from 'vitest';
import { mapHostexCalendarDay } from './calendar-mapper.js';
import type { HostexCalendarDay, HostexReservation } from '../../types/hostex.js';

const baseDay: HostexCalendarDay = {
  date: '2026-06-01',
  price: 149,
  inventory: 1,
  restrictions: {
    min_stay_on_arrival: 2,
    max_stay_on_arrival: 30,
    closed_on_arrival: false,
    closed_on_departure: false,
  },
};

const resOverlapping: HostexReservation = {
  reservation_code: 'R-001',
  stay_code: 'R-001',
  channel_id: 'AIRBNB-XYZ',
  channel_type: 'airbnb',
  listing_id: 'L1',
  property_id: 12659676,
  status: 'accepted',
  check_in_date: '2026-06-01',
  check_out_date: '2026-06-03',
};

describe('mapHostexCalendarDay', () => {
  it('available day with no reservation', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('available');
    expect(out.block_type).toBeNull();
    expect(out.block_ref).toBeNull();
  });

  it('booked day: reservation overlaps', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [resOverlapping],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('booked');
    expect(out.block_type).toBe('reservation');
    expect(out.block_ref).toBe('R-001');
  });

  it('blocked day: inventory=0 without reservation', () => {
    const day: HostexCalendarDay = { ...baseDay, inventory: 0 };
    const out = mapHostexCalendarDay({
      day,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('blocked');
    expect(out.block_type).toBeNull();
  });

  it('reservation takes priority over inventory=0', () => {
    const day: HostexCalendarDay = { ...baseDay, inventory: 0 };
    const out = mapHostexCalendarDay({
      day,
      listingId: '12659676',
      reservationsForDate: [resOverlapping],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('booked');
  });

  it('price + restrictions are passed through', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.price).toBe(149);
    expect(out.min_nights).toBe(2);
    expect(out.closed_to_arrival).toBe(false);
    expect(out.closed_to_departure).toBe(false);
  });

  it('listing_id + date are persisted', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.listing_id).toBe('12659676');
    expect(out.date).toBe('2026-06-01');
  });
});
