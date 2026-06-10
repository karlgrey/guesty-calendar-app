import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getCurrentReservations } from './reservation-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE reservations (
    id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT,
    check_in TEXT, check_out TEXT, status TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function ins(reservation_id: string, checkInExpr: string, checkOutExpr: string, status = 'confirmed') {
  db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status)
    VALUES (?, 'A', date('now', ?), date('now', ?), ?)`).run(reservation_id, checkInExpr, checkOutExpr, status);
}

describe('getCurrentReservations', () => {
  it('returns only in-house stays (check_in <= today < check_out, active status)', () => {
    ins('current', '-1 day', '+1 day');        // in-house now -> included
    ins('future', '+2 day', '+5 day');         // not started -> excluded
    ins('past', '-5 day', '-1 day');           // ended -> excluded
    ins('leaves-today', '-3 day', '+0 day');   // checkout today -> excluded
    ins('cancelled-current', '-1 day', '+1 day', 'canceled'); // active-status filter -> excluded
    const ids = getCurrentReservations('A').map((r) => r.reservation_id);
    expect(ids).toEqual(['current']);
  });

  it('returns [] for a listing with no current stays', () => {
    ins('future', '+2 day', '+5 day');
    expect(getCurrentReservations('B')).toEqual([]);
  });
});
