import { describe, it, expect } from 'vitest';
import { buildAvailabilityRows } from './availability-mapper.js';
import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';

const events: AirbnbIcalEvent[] = [
  { uid: 'HMA@airbnb.com', reservationCode: 'HMA', startDate: '2026-07-01', endDate: '2026-07-04', summary: 'Reserved' },
];

describe('buildAvailabilityRows', () => {
  it('returns one row per day in window', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-08',
      events: [],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows.length).toBe(7);
  });

  it('marks days inside event range as booked', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-08',
      events,
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('booked'); // 07-01
    expect(rows[0].block_ref).toBe('HMA');
    expect(rows[1].status).toBe('booked'); // 07-02
    expect(rows[2].status).toBe('booked'); // 07-03
    expect(rows[3].status).toBe('available'); // 07-04 (endDate exclusive)
  });

  it('uses base_price for every row', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 137,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].price).toBe(137);
  });

  it('uses default min_nights', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 100,
      defaultMinNights: 2,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].min_nights).toBe(2);
  });

  it('listing_id, date, last_synced_at are persisted', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].listing_id).toBe('999');
    expect(rows[0].date).toBe('2026-07-01');
    expect(rows[0].last_synced_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('classifies "Airbnb (Not available)" events as owner blocks', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-05',
      events: [
        { uid: 'BLK@airbnb.com', reservationCode: 'BLK', startDate: '2026-07-02', endDate: '2026-07-04', summary: 'Airbnb (Not available)' },
      ],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('available');           // 07-01
    expect(rows[1].status).toBe('blocked');             // 07-02
    expect(rows[1].block_type).toBe('owner');
    expect(rows[1].block_ref).toBe(null);
    expect(rows[2].status).toBe('blocked');             // 07-03
    expect(rows[3].status).toBe('available');           // 07-04 (endDate exclusive)
  });

  it('reserved events stay booked/reservation; block match is case-insensitive', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-03',
      events: [
        { uid: 'R@airbnb.com', reservationCode: 'R', startDate: '2026-07-01', endDate: '2026-07-02', summary: 'Reserved' },
        { uid: 'B@airbnb.com', reservationCode: 'B', startDate: '2026-07-02', endDate: '2026-07-03', summary: 'AIRBNB (NOT AVAILABLE)' },
      ],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('booked');
    expect(rows[0].block_type).toBe('reservation');
    expect(rows[1].status).toBe('blocked');
    expect(rows[1].block_type).toBe('owner');
  });
});
