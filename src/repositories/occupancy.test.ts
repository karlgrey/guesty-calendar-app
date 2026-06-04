import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getOccupancyBreakdown, getOccupancyRate } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT);`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seed(statuses: string[]) {
  const ins = db.prepare(`INSERT INTO availability (listing_id,date,status) VALUES (?,?,?)`);
  statuses.forEach((s, i) => ins.run('A', `2026-06-${String(i + 1).padStart(2, '0')}`, s));
}

describe('getOccupancyBreakdown', () => {
  it('excludes blocked from the sellable base: booked / (total - blocked)', () => {
    // 10 booked, 5 blocked, 15 available -> total 30, sellable 25, rate 40%
    seed([
      ...Array(10).fill('booked'),
      ...Array(5).fill('blocked'),
      ...Array(15).fill('available'),
    ]);
    const b = getOccupancyBreakdown('A', '2026-06-01', '2026-07-01');
    expect(b.bookedDays).toBe(10);
    expect(b.blockedDays).toBe(5);
    expect(b.totalDays).toBe(30);
    expect(b.sellableDays).toBe(25);
    expect(b.rate).toBe(40);
  });

  it('all blocked -> rate 0', () => {
    seed(Array(4).fill('blocked'));
    const b = getOccupancyBreakdown('A', '2026-06-01', '2026-07-01');
    expect(b.sellableDays).toBe(0);
    expect(b.rate).toBe(0);
  });
});

describe('getOccupancyRate', () => {
  it('returns the sellable rate (delegates to breakdown)', () => {
    seed([...Array(10).fill('booked'), ...Array(5).fill('blocked'), ...Array(15).fill('available')]);
    expect(getOccupancyRate('A', '2026-06-01', '2026-07-01')).toBe(40);
  });
});
