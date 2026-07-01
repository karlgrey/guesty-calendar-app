import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsNeedingDraft } from './message-repository.js';

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
    CREATE TABLE message_drafts (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', generated_by TEXT NOT NULL DEFAULT 'manual',
      send_attempts INTEGER NOT NULL DEFAULT 0, external_message_id TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, model TEXT
    );
  `);
  setDatabase(db);
  const t = db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at) VALUES (?,?,?,?,?,?,?)`);
  t.run('hostex:a', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T10:00Z', 'now'); // inbound-latest, no draft -> needs draft
  t.run('hostex:b', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T11:00Z', 'now'); // inbound-latest, HAS pending draft -> excluded
  t.run('hostex:c', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T09:00Z', 'now'); // outbound-latest -> excluded
  t.run('hostex:d', 'L2', 'hostex', 'airbnb', 't', '2026-06-30T12:00Z', 'now'); // other listing -> excluded by filter
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source) VALUES (?,?,?,?,?,?)`);
  m.run('m1', 'hostex:a', 'inbound', '2026-06-30T10:00Z', 'q', 'hostex');
  m.run('m2', 'hostex:b', 'inbound', '2026-06-30T11:00Z', 'q', 'hostex');
  m.run('m3', 'hostex:c', 'inbound', '2026-06-30T08:00Z', 'q', 'hostex');
  m.run('m4', 'hostex:c', 'outbound', '2026-06-30T09:00Z', 'a', 'hostex');
  m.run('m5', 'hostex:d', 'inbound', '2026-06-30T12:00Z', 'q', 'hostex');
  db.prepare(`INSERT INTO message_drafts (id,thread_id,provider,body,status,generated_by) VALUES ('dp','hostex:b','hostex','draft','pending','llm')`).run();
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsNeedingDraft', () => {
  it('returns L1 hostex threads with inbound-latest and no pending draft, respecting limit', () => {
    expect(getThreadsNeedingDraft('L1', 10).map((t) => t.id)).toEqual(['hostex:a']);
  });
  it('respects the limit', () => {
    expect(getThreadsNeedingDraft('L1', 0).length).toBe(0);
  });
});
