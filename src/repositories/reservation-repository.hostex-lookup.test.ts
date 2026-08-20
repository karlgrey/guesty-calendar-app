// #441: getInquiryByHostexConversationId is the join sync-hostex-messages.ts uses to resolve
// message_threads.reservation_status for Hostex threads (whose conversation DETAIL carries no
// reservation status, unlike Guesty's). Exercised against the REAL migrations (003 + 024), not a
// hand-rolled schema, so a drift between the SQL and the repository code shows up here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getInquiryByHostexConversationId } from './reservation-repository.js';

let db: Database.Database;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO listings (id) VALUES ('12659676');`);
  db.exec(readFileSync(join(migrationsDir, '003_add_inquiries_table.sql'), 'utf-8'));
  db.exec(readFileSync(join(migrationsDir, '024_add_hostex_conversation_id.sql'), 'utf-8'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function insertInquiry(overrides: Record<string, unknown> = {}) {
  const row = {
    inquiry_id: 'R-001',
    listing_id: '12659676',
    status: 'confirmed',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    guest_name: 'Anke Morgenroth',
    guests_count: 2,
    source: 'airbnb',
    created_at_guesty: '2026-05-01T10:00:00Z',
    last_synced_at: '2026-05-01T10:00:00Z',
    hostex_conversation_id: 'conv-123',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO inquiries (
      inquiry_id, listing_id, status, check_in, check_out,
      guest_name, guests_count, source, created_at_guesty, last_synced_at, hostex_conversation_id
    ) VALUES (@inquiry_id, @listing_id, @status, @check_in, @check_out,
      @guest_name, @guests_count, @source, @created_at_guesty, @last_synced_at, @hostex_conversation_id)
  `).run(row);
}

describe('getInquiryByHostexConversationId', () => {
  it('finds the inquiry by its linked Hostex conversation id', () => {
    insertInquiry();
    const found = getInquiryByHostexConversationId('conv-123');
    expect(found?.inquiry_id).toBe('R-001');
    expect(found?.status).toBe('confirmed');
  });

  it('returns null when no inquiry is linked to that conversation id', () => {
    insertInquiry();
    expect(getInquiryByHostexConversationId('conv-does-not-exist')).toBeNull();
  });

  it('returns null when hostex_conversation_id is NULL on the row (no matching-on-NULL)', () => {
    insertInquiry({ inquiry_id: 'R-002', hostex_conversation_id: null });
    // Querying with an empty string must not accidentally match a NULL column.
    expect(getInquiryByHostexConversationId('')).toBeNull();
  });

  it('reflects the mapper vocabulary (e.g. cancelled reservation → status "canceled")', () => {
    insertInquiry({ inquiry_id: 'R-003', hostex_conversation_id: 'conv-999', status: 'canceled' });
    expect(getInquiryByHostexConversationId('conv-999')?.status).toBe('canceled');
  });
});
