import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getLeadTimeSamples, getRevenueForCheckInMonth } from './reservation-repository.js';
import { getOccupancyCounts } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT,
      check_in TEXT, check_out TEXT, nights_count INTEGER,
      status TEXT, host_payout REAL, total_price REAL, reserved_at TEXT
    );
    CREATE TABLE availability (
      id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT
    );
  `);
  setDatabase(db);
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('getLeadTimeSamples', () => {
  it('returns checkIn/reservedAt across all listings, skips null reserved_at', () => {
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r1', 'A', '2026-07-10', '2026-07-15', 'confirmed', '2026-06-01T00:00:00Z');
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r2', 'B', '2026-08-01', '2026-08-05', 'reserved', '2026-07-20T00:00:00Z');
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r3', 'A', '2026-09-01', '2026-09-03', 'confirmed', null);
    const samples = getLeadTimeSamples();
    expect(samples).toHaveLength(2);
    expect(samples).toContainEqual({ checkIn: '2026-07-10', reservedAt: '2026-06-01T00:00:00Z' });
  });
});

describe('getRevenueForCheckInMonth', () => {
  it('sums host_payout for confirmed/reserved with check_in in the given month', () => {
    const ins = db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,host_payout,total_price) VALUES (?,?,?,?,?,?,?)`);
    ins.run('r1', 'A', '2026-06-10', '2026-06-12', 'confirmed', 500, 600);
    ins.run('r2', 'A', '2026-06-20', '2026-06-22', 'reserved', null, 300); // falls back to total_price
    ins.run('r3', 'A', '2026-07-01', '2026-07-03', 'confirmed', 999, 999); // other month
    ins.run('r4', 'A', '2026-06-25', '2026-06-27', 'canceled', 999, 999);  // excluded status
    expect(getRevenueForCheckInMonth('A', '2026-06')).toBe(800);
  });
});

describe('getOccupancyCounts', () => {
  it('counts booked/blocked days vs total in [start,end)', () => {
    const ins = db.prepare(`INSERT INTO availability (listing_id,date,status) VALUES (?,?,?)`);
    ins.run('A', '2026-06-01', 'booked');
    ins.run('A', '2026-06-02', 'blocked');
    ins.run('A', '2026-06-03', 'available');
    ins.run('A', '2026-06-04', 'available');
    const c = getOccupancyCounts('A', '2026-06-01', '2026-06-05');
    expect(c).toEqual({ occupiedDays: 2, totalDays: 4 });
  });
});
