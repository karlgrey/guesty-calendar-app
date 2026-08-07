// src/repositories/airbnb-mail-archive-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getLastSyncAt, setLastUid } from './airbnb-mail-archive-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE airbnb_mail_state (
      property_slug TEXT PRIMARY KEY,
      last_imap_uid INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('getLastSyncAt', () => {
  it('returns null for a property that never synced (no state row)', () => {
    expect(getLastSyncAt('firenze-loft')).toBeNull();
  });

  it('returns the persisted last_sync_at after setLastUid()', () => {
    setLastUid('firenze-loft', 42);
    const lastSyncAt = getLastSyncAt('firenze-loft');
    expect(lastSyncAt).not.toBeNull();
    // SQLite datetime('now') format, sanity-check it round-trips as a real date
    expect(new Date(`${lastSyncAt!.replace(' ', 'T')}Z`).toString()).not.toBe('Invalid Date');
  });
});
