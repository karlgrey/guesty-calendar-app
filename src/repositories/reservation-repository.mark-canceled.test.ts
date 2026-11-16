// #1143: markReservationCanceled — Status setzen, Zeile behalten; Kalender-Sync liest nur aktive Status.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { markReservationCanceled, getReservationsByPeriod, getReservationById } from './reservation-repository.js';

const LISTING = '1678837365136764301';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
let db: Database.Database;
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function insert(id: string, ci: string, co: string) {
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, source, platform, host_payout, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, 2, 'confirmed', 'airbnb', 'airbnb-mail', 1234, 'x')`).run(id, LISTING, ci, co, ci, co);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO listings (id) VALUES ('${LISTING}');`);
  for (const m of ['002_add_reservations_table.sql', '003_add_inquiries_table.sql', '012_add_guest_fingerprint.sql']) {
    db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
  }
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('markReservationCanceled', () => {
  it('setzt Status, löscht nicht, lässt Payout unverändert, setzt inquiries', () => {
    insert('HMX1', day(5), day(7));
    db.prepare(`INSERT INTO inquiries (inquiry_id, listing_id, status, check_in, check_out, last_synced_at) VALUES ('HMX1', ?, 'confirmed', ?, ?, 'x')`).run(LISTING, day(5), day(7));
    expect(markReservationCanceled('HMX1')).toEqual({ reservations: 1, inquiries: 1 });
    const row = getReservationById('HMX1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('canceled');
    expect(row!.host_payout).toBe(1234);
    expect((db.prepare(`SELECT status FROM inquiries WHERE inquiry_id='HMX1'`).get() as any).status).toBe('canceled');
  });

  it('unbekannte ID → 0/0', () => {
    expect(markReservationCanceled('NOPE')).toEqual({ reservations: 0, inquiries: 0 });
  });

  it('stornierte Zeile fehlt in getReservationsByPeriod future und past', () => {
    insert('HMF', day(5), day(7));
    insert('HMP', day(-7), day(-5));
    expect(getReservationsByPeriod(LISTING, 365, 'future').map((r) => r.reservation_id)).toEqual(['HMF']);
    expect(getReservationsByPeriod(LISTING, 365, 'past').map((r) => r.reservation_id)).toEqual(['HMP']);
    markReservationCanceled('HMF');
    markReservationCanceled('HMP');
    expect(getReservationsByPeriod(LISTING, 365, 'future')).toHaveLength(0);
    expect(getReservationsByPeriod(LISTING, 365, 'past')).toHaveLength(0);
  });
});
