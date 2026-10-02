// #793: ETL-Upsert darf per PATCH gesetzte geplante Zeiten nicht mit NULL löschen.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import { upsertReservation, getReservationById } from './reservation-repository.js';

let db: Database.Database;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO listings (id) VALUES ('L1');`);
  db.exec(readFileSync(join(migrationsDir, '002_add_reservations_table.sql'), 'utf-8'));
  db.exec(readFileSync(join(migrationsDir, '012_add_guest_fingerprint.sql'), 'utf-8'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const row = (over: Record<string, unknown> = {}) => ({
  reservation_id: 'res-1', listing_id: 'L1', check_in: '2026-12-01', check_out: '2026-12-03',
  check_in_localized: '2026-12-01', check_out_localized: '2026-12-03', nights_count: 2,
  guest_id: null, guest_name: 'X', guests_count: 2, adults_count: 2, children_count: null, infants_count: null,
  status: 'confirmed', confirmation_code: null, source: 'manual', platform: null,
  planned_arrival: null, planned_departure: null, currency: 'EUR', total_price: null, host_payout: null,
  balance_due: null, total_paid: null, created_at_guesty: null, reserved_at: null, last_synced_at: 'x',
  internal_guest_id: null, guest_company: null, ...over,
}) as any;

describe('upsertReservation — planned_* (#793)', () => {
  it('NULL aus dem ETL überschreibt gesetzte geplante Zeiten nicht', () => {
    upsertReservation(row({ planned_arrival: '14:00', planned_departure: '18:00' }));
    upsertReservation(row());
    const r = getReservationById('res-1')!;
    expect([r.planned_arrival, r.planned_departure]).toEqual(['14:00', '18:00']);
  });

  it('ein neuer Wert überschreibt den alten', () => {
    upsertReservation(row({ planned_departure: '18:00' }));
    upsertReservation(row({ planned_departure: '19:00' }));
    expect(getReservationById('res-1')!.planned_departure).toBe('19:00');
  });
});
