// #802: lokale Availability-Zeile nach Folgetag-Block/-Rücknahme sofort nachziehen
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { setLocalDayBlocked } from './availability-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT, block_type TEXT, block_ref TEXT, updated_at TEXT);
    INSERT INTO availability (listing_id, date, status, block_type, block_ref) VALUES
      ('L', '2026-12-03', 'blocked', NULL, NULL),
      ('L', '2026-12-04', 'available', NULL, NULL),
      ('L', '2026-12-05', 'available', NULL, NULL),
      ('M', '2026-12-04', 'available', NULL, NULL),
      ('L', '2026-12-06', 'booked', 'reservation', 'res-1');`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const row = (l: string, d: string) => db.prepare('SELECT status, block_type, block_ref FROM availability WHERE listing_id = ? AND date = ?').get(l, d);

describe('setLocalDayBlocked', () => {
  it('blocked: setzt genau die eine Zeile auf blocked/manual', () => {
    expect(setLocalDayBlocked('L', '2026-12-04', true)).toBe(true);
    expect(row('L', '2026-12-04')).toEqual({ status: 'blocked', block_type: 'manual', block_ref: null });
    expect(row('L', '2026-12-03')).toEqual({ status: 'blocked', block_type: null, block_ref: null });
    expect(row('L', '2026-12-05')).toMatchObject({ status: 'available' });
    expect(row('M', '2026-12-04')).toMatchObject({ status: 'available' });
  });

  it('frei: setzt zurück auf available/null', () => {
    setLocalDayBlocked('L', '2026-12-04', true);
    expect(setLocalDayBlocked('L', '2026-12-04', false)).toBe(true);
    expect(row('L', '2026-12-04')).toEqual({ status: 'available', block_type: null, block_ref: null });
  });

  it('Tag ohne lokale Zeile: false, nichts angelegt', () => {
    expect(setLocalDayBlocked('L', '2027-01-01', true)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM availability').get()).toEqual({ n: 5 });
  });

  it('booked-Zeile (Reservierung) wird nie umgeschrieben — weder blocked noch available', () => {
    expect(setLocalDayBlocked('L', '2026-12-06', true)).toBe(false);
    expect(setLocalDayBlocked('L', '2026-12-06', false)).toBe(false);
    expect(row('L', '2026-12-06')).toEqual({ status: 'booked', block_type: 'reservation', block_ref: 'res-1' });
  });
});
