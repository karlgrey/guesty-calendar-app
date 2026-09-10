import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsUpdatedSince } from './message-repository.js';

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
    (id,listing_id,source,channel,guest_name,first_message_at,last_message_at,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  // Dates RELATIVE to now so the window is deterministic whenever the suite runs.
  t.run('hostex:a', 'L', 'hostex', 'airbnb', 'Anna', datetime('-2 days'), datetime('-1 day'), 'now');
  t.run('guesty:b', 'L', 'guesty', 'airbnb', 'Ben', datetime('-3 days'), datetime('-2 days'), 'now');
  t.run('guesty:old', 'L', 'guesty', 'airbnb', 'Old', datetime('-40 days'), datetime('-30 days'), 'now');
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,from_name,body,source)
    VALUES (?,?,?,?,?,?,?)`);
  // Thread a: last non-system message is inbound -> needs reply
  m.run('m1', 'hostex:a', 'inbound', datetime('-1 day'), 'Anna', 'Frage', 'hostex');
  // Thread b: last non-system message is outbound (bot answered) -> answered
  m.run('m2', 'guesty:b', 'inbound', datetime('-3 days'), 'Ben', 'Frage', 'guesty');
  m.run('m3', 'guesty:b', 'outbound', datetime('-2 days'), 'host', 'Antwort', 'guesty');
  // Thread old: outside the default window
  m.run('m4', 'guesty:old', 'inbound', datetime('-30 days'), 'Old', 'Frage', 'guesty');
});
afterEach(() => { resetDatabase(); db.close(); });

function datetime(modifier: string): string {
  return db.prepare(`SELECT datetime('now', ?) AS d`).pluck().get(modifier) as string;
}

describe('getThreadsUpdatedSince', () => {
  it('returns threads with activity since the given timestamp, newest first', () => {
    const since = datetime('-7 days');
    const rows = getThreadsUpdatedSince(since, 50);
    expect(rows.map((r) => r.id)).toEqual(['hostex:a', 'guesty:b']);
  });

  it('excludes threads outside the window', () => {
    const since = datetime('-7 days');
    const rows = getThreadsUpdatedSince(since, 50);
    expect(rows.find((r) => r.id === 'guesty:old')).toBeUndefined();
  });

  it('includes older threads when a wider window is requested', () => {
    const since = datetime('-60 days');
    const rows = getThreadsUpdatedSince(since, 50);
    expect(rows.map((r) => r.id)).toEqual(['hostex:a', 'guesty:b', 'guesty:old']);
  });

  it('respects the limit', () => {
    const since = datetime('-60 days');
    const rows = getThreadsUpdatedSince(since, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('hostex:a');
  });

  it('derives last_message_direction ignoring system posts', () => {
    const since = datetime('-7 days');
    const rows = getThreadsUpdatedSince(since, 50);
    const a = rows.find((r) => r.id === 'hostex:a')!;
    const b = rows.find((r) => r.id === 'guesty:b')!;
    expect(a.last_message_direction).toBe('inbound');
    expect(b.last_message_direction).toBe('outbound');
  });
});
