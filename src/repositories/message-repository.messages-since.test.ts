import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getMessagesSince } from './message-repository.js';

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
  // Dates RELATIVE to now so the 14-day window is deterministic whenever the suite runs.
  t.run('hostex:a', 'L1', 'hostex', 'airbnb', 'Anna', datetime('-3 days'), datetime('-1 day'), 'now');
  t.run('guesty:b', 'L2', 'guesty', 'booking.com', 'Ben', datetime('-13 days'), datetime('-13 days'), 'now');
  t.run('guesty:old', 'L2', 'guesty', 'airbnb', 'Old', datetime('-40 days'), datetime('-20 days'), 'now');
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source)
    VALUES (?,?,?,?,?,?)`);
  m.run('m1', 'hostex:a', 'inbound', datetime('-3 days'), 'Erste Frage', 'hostex');
  m.run('m2', 'hostex:a', 'outbound', datetime('-1 day'), 'Antwort', 'hostex');
  m.run('m3', 'guesty:b', 'inbound', datetime('-13 days'), 'Noch offen', 'guesty');
  // Outside the 14-day window entirely -> must never appear.
  m.run('m4', 'guesty:old', 'inbound', datetime('-20 days'), 'Uralt', 'guesty');
});
afterEach(() => { resetDatabase(); db.close(); });

function datetime(modifier: string): string {
  return db.prepare(`SELECT datetime('now', ?) AS d`).pluck().get(modifier) as string;
}

describe('getMessagesSince', () => {
  it('liefert nur Nachrichten seit dem Stichtag, neueste zuerst', () => {
    const since = datetime('-14 days');
    const rows = getMessagesSince(since);
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1', 'm3']);
  });

  it('schließt Nachrichten außerhalb des Fensters aus', () => {
    const since = datetime('-14 days');
    const rows = getMessagesSince(since);
    expect(rows.find((r) => r.id === 'm4')).toBeUndefined();
  });

  it('liefert die Join-Felder aus dem Thread (guest_name, source, listing_id, channel)', () => {
    const since = datetime('-14 days');
    const rows = getMessagesSince(since);
    const row = rows.find((r) => r.id === 'm1')!;
    expect(row).toMatchObject({
      thread_id: 'hostex:a', guest_name: 'Anna', source: 'hostex', listing_id: 'L1', channel: 'airbnb',
    });
  });

  it('respektiert das Limit', () => {
    const since = datetime('-14 days');
    const rows = getMessagesSince(since, 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1']);
  });

  it('ein weiteres Fenster schließt auch alte Nachrichten ein', () => {
    const since = datetime('-60 days');
    const rows = getMessagesSince(since);
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1', 'm3', 'm4']);
  });
});
