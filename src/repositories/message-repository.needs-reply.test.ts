import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsNeedingReply } from './message-repository.js';

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
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL,
      from_name TEXT, from_address TEXT, to_address TEXT, subject TEXT, body TEXT NOT NULL, body_html TEXT,
      source TEXT NOT NULL, raw_meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);
  const t = db.prepare(`INSERT INTO message_threads
    (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at)
    VALUES (?,?,?,?,?,?,?)`);
  t.run('hostex:a', 'L', 'hostex', 'airbnb', '2026-06-30T09:00:00Z', '2026-06-30T10:00:00Z', 'now');
  t.run('hostex:b', 'L', 'hostex', 'airbnb', '2026-06-30T09:00:00Z', '2026-06-30T11:00:00Z', 'now');
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source)
    VALUES (?,?,?,?,?,?)`);
  // Thread a: last message is inbound -> needs reply
  m.run('m1', 'hostex:a', 'inbound', '2026-06-30T10:00:00Z', 'Frage', 'hostex');
  // Thread b: last message is outbound (already answered) -> no reply needed
  m.run('m2', 'hostex:b', 'inbound', '2026-06-30T10:00:00Z', 'Frage', 'hostex');
  m.run('m3', 'hostex:b', 'outbound', '2026-06-30T11:00:00Z', 'Antwort', 'hostex');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsNeedingReply', () => {
  it('returns only threads whose latest message is inbound', () => {
    const ids = getThreadsNeedingReply().map((t) => t.id);
    expect(ids).toEqual(['hostex:a']);
  });
});
