import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getGuestyThreadsForListing } from './message-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_threads (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
      conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
      raw_meta TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE reservations (id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT, check_in TEXT, check_out TEXT);
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const ins = (id: string, listing: string, source: string, res: string | null) =>
  db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,reservation_id,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, listing, source, 'airbnb', 't', 't', res, 't');

describe('getGuestyThreadsForListing', () => {
  it('filtert auf source=guesty + listing und joined Reservierungs-Check-in/-Check-out', () => {
    ins('guesty:a', 'L1', 'guesty', 'R1');
    ins('guesty:b', 'L1', 'guesty', null);
    ins('guesty:c', 'L2', 'guesty', 'R1');
    ins('hostex:d', 'L1', 'hostex', 'R1');
    db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out) VALUES ('R1','L1','2026-07-05','2026-07-10')`).run();
    const rows = getGuestyThreadsForListing('L1');
    expect(rows.map((r) => r.id).sort()).toEqual(['guesty:a', 'guesty:b']);
    expect(rows.find((r) => r.id === 'guesty:a')!.reservation_check_out).toBe('2026-07-10');
    expect(rows.find((r) => r.id === 'guesty:a')!.reservation_check_in).toBe('2026-07-05');
    expect(rows.find((r) => r.id === 'guesty:b')!.reservation_check_out).toBeNull();
    expect(rows.find((r) => r.id === 'guesty:b')!.reservation_check_in).toBeNull();
  });
});
