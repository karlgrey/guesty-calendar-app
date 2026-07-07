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

  // last_message_at / sent_at are set RELATIVE to now so the recency filter is
  // deterministic regardless of the wall clock when the suite runs.
  const t = db.prepare(
    `INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at)
     VALUES (?,?,?,?,datetime('now','-1 day'),datetime('now', ?),datetime('now'))`,
  );
  t.run('hostex:a', 'L1', 'hostex', 'airbnb', '-1 hour'); // fresh inbound, no draft -> NEEDS draft
  t.run('hostex:b', 'L1', 'hostex', 'airbnb', '-1 hour'); // fresh inbound, HAS pending draft -> excluded
  t.run('hostex:c', 'L1', 'hostex', 'airbnb', '-1 hour'); // fresh but outbound-latest -> excluded
  t.run('hostex:d', 'L2', 'hostex', 'airbnb', '-1 hour'); // other listing -> excluded
  t.run('hostex:e', 'L1', 'hostex', 'airbnb', '-10 days'); // inbound but STALE -> excluded by recency
  t.run('guesty:g1', 'GL1', 'guesty', 'airbnb', '-1 hour'); // fresh guesty inbound -> NEEDS draft (source=guesty)

  const m = db.prepare(
    `INSERT INTO messages (id,thread_id,direction,sent_at,body,source) VALUES (?,?,?,datetime('now', ?),?,?)`,
  );
  m.run('m1', 'hostex:a', 'inbound', '-1 hour', 'q', 'hostex');
  m.run('m2', 'hostex:b', 'inbound', '-1 hour', 'q', 'hostex');
  m.run('m3c', 'hostex:c', 'inbound', '-2 hour', 'q', 'hostex');
  m.run('m4c', 'hostex:c', 'outbound', '-1 hour', 'a', 'hostex'); // latest is outbound
  m.run('m5', 'hostex:d', 'inbound', '-1 hour', 'q', 'hostex');
  m.run('m6', 'hostex:e', 'inbound', '-10 days', 'q', 'hostex');
  m.run('mg1', 'guesty:g1', 'inbound', '-1 hour', 'q', 'guesty');

  db.prepare(
    `INSERT INTO message_drafts (id,thread_id,provider,body,status,generated_by) VALUES ('dp','hostex:b','hostex','draft','pending','llm')`,
  ).run();
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsNeedingDraft', () => {
  it('returns only fresh L1 hostex threads with inbound-latest and no pending draft', () => {
    // included: hostex:a. excluded: b(draft), c(outbound-latest), d(other listing), e(stale)
    expect(getThreadsNeedingDraft('hostex', 'L1', 10, '-72 hours').map((r) => r.id)).toEqual(['hostex:a']);
  });

  it('excludes threads whose last message is older than the recency window', () => {
    // A very tight window drops even the -1h "fresh" thread.
    expect(getThreadsNeedingDraft('hostex', 'L1', 10, '-1 second')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(getThreadsNeedingDraft('hostex', 'L1', 0, '-72 hours').length).toBe(0);
  });

  it('filters by source: guesty listing only returns guesty threads', () => {
    expect(getThreadsNeedingDraft('guesty', 'GL1', 10, '-72 hours').map((r) => r.id)).toEqual(['guesty:g1']);
    expect(getThreadsNeedingDraft('hostex', 'GL1', 10, '-72 hours')).toEqual([]);
  });
});
