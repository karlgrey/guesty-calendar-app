import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsByReservationId, getThreadsByListingAndGuestName } from './message-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_threads (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
      conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
      raw_meta TEXT, ai_no_reply_at TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);

  const t = db.prepare(
    `INSERT INTO message_threads (id,listing_id,source,channel,guest_name,reservation_id,first_message_at,last_message_at,last_synced_at)
     VALUES (?,?,?,?,?,?,datetime('now','-2 day'),datetime('now','-1 day'),datetime('now'))`,
  );
  t.run('guesty:g1', 'GL1', 'guesty', 'airbnb', 'Darleen', 'res-123');
  t.run('guesty:g2', 'GL1', 'guesty', 'airbnb', 'Other Guest', 'res-999'); // different reservation -> excluded
  t.run('hostex:h1', 'L1', 'hostex', 'airbnb', 'Darleen Smith', null);   // no reservation_id (Hostex limitation)
  t.run('hostex:h2', 'L1', 'hostex', 'airbnb', 'Someone Else', null);
  t.run('hostex:h3', 'L2', 'hostex', 'airbnb', 'Darleen Smith', null);   // right name, wrong listing -> excluded
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsByReservationId', () => {
  it('returns only threads linked to the given reservation', () => {
    expect(getThreadsByReservationId('res-123').map((t) => t.id)).toEqual(['guesty:g1']);
  });

  it('returns [] when no thread is linked', () => {
    expect(getThreadsByReservationId('res-does-not-exist')).toEqual([]);
  });
});

describe('getThreadsByListingAndGuestName', () => {
  it('matches case/whitespace-insensitively within the given listing', () => {
    expect(getThreadsByListingAndGuestName('L1', '  darleen smith  ').map((t) => t.id)).toEqual(['hostex:h1']);
  });

  it('does not match a different listing even with the same guest name', () => {
    expect(getThreadsByListingAndGuestName('L2', 'Darleen Smith').map((t) => t.id)).toEqual(['hostex:h3']);
    expect(getThreadsByListingAndGuestName('L1', 'Someone Else').map((t) => t.id)).toEqual(['hostex:h2']);
  });

  it('returns [] when no guest name matches', () => {
    expect(getThreadsByListingAndGuestName('L1', 'Nobody Here')).toEqual([]);
  });

  it('only matches hostex-source threads', () => {
    // guesty:g1 has guest_name 'Darleen' in listing GL1 — must not leak into a hostex lookup
    expect(getThreadsByListingAndGuestName('GL1', 'Darleen')).toEqual([]);
  });
});
