import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getLastMessageSync } from './message-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_threads (
    id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
    guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
    conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
    raw_meta TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function ins(id: string, source: string, lastSynced: string) {
  db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, 'L', source, 'airbnb', 't', 't', lastSynced);
}

describe('getLastMessageSync', () => {
  it('returns null when there are no hostex/guesty threads', () => {
    ins('gmail:a', 'gmail', '2026-06-30T10:00:00Z'); // other sources ignored
    expect(getLastMessageSync()).toBeNull();
  });

  it('returns the newest last_synced_at across hostex threads', () => {
    ins('hostex:a', 'hostex', '2026-06-30T10:00:00Z');
    ins('hostex:b', 'hostex', '2026-06-30T12:00:00Z');
    expect(getLastMessageSync()).toBe('2026-06-30T12:00:00Z');
  });

  it('considers guesty threads too — the newer of both providers wins', () => {
    ins('hostex:a', 'hostex', '2026-06-30T10:00:00Z');
    ins('guesty:c', 'guesty', '2026-06-30T23:00:00Z');
    expect(getLastMessageSync()).toBe('2026-06-30T23:00:00Z');
  });
});
