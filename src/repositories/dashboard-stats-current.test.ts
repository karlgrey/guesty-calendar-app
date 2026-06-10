import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getDashboardStats } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT, check_in TEXT, check_out TEXT, status TEXT, host_payout REAL, total_price REAL);
    CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT);
  `);
  setDatabase(db);
  // one in-house stay: checked in yesterday, leaves tomorrow, 500 payout
  db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,host_payout,total_price)
    VALUES ('cur','A', date('now','-1 day'), date('now','+1 day'), 'confirmed', 500, 600)`).run();
});
afterEach(() => { resetDatabase(); db.close(); });

describe("getDashboardStats — in-house stay counts in 'future'", () => {
  it('future stats count the in-house booking', () => {
    const s = getDashboardStats('A', 365, 'future');
    expect(s.totalBookings).toBe(1);
    expect(s.totalRevenue).toBe(500);
  });

  it('past stats do NOT count the in-house booking', () => {
    const s = getDashboardStats('A', 365, 'past');
    expect(s.totalBookings).toBe(0);
  });
});
