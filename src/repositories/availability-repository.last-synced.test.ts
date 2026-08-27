import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getAvailabilityLastSyncedAt } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    `CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT, last_synced_at TEXT);`
  );
  setDatabase(db);
});
afterEach(() => {
  resetDatabase();
  db.close();
});

function seed(rows: Array<{ listingId: string; date: string; lastSyncedAt: string }>) {
  const ins = db.prepare(`INSERT INTO availability (listing_id, date, status, last_synced_at) VALUES (?, ?, 'available', ?)`);
  for (const r of rows) ins.run(r.listingId, r.date, r.lastSyncedAt);
}

describe('getAvailabilityLastSyncedAt', () => {
  it('gibt den jüngsten last_synced_at-Zeitstempel für die Listing zurück', () => {
    seed([
      { listingId: 'A', date: '2026-09-01', lastSyncedAt: '2026-08-27T05:00:00.000Z' },
      { listingId: 'A', date: '2026-09-02', lastSyncedAt: '2026-08-27T05:32:11.000Z' },
      { listingId: 'A', date: '2026-09-03', lastSyncedAt: '2026-08-27T05:10:00.000Z' },
    ]);
    expect(getAvailabilityLastSyncedAt('A')).toBe('2026-08-27T05:32:11.000Z');
  });

  it('ignoriert Zeilen anderer Listings', () => {
    seed([
      { listingId: 'A', date: '2026-09-01', lastSyncedAt: '2026-08-27T05:00:00.000Z' },
      { listingId: 'B', date: '2026-09-01', lastSyncedAt: '2026-08-27T09:00:00.000Z' },
    ]);
    expect(getAvailabilityLastSyncedAt('A')).toBe('2026-08-27T05:00:00.000Z');
  });

  it('gibt null zurück, wenn keine Zeilen existieren', () => {
    expect(getAvailabilityLastSyncedAt('unknown-listing')).toBeNull();
  });
});
