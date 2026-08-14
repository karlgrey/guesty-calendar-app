import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { upsertReservation, upsertReservationBatch } from './reservation-repository.js';

let db: Database.Database;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO listings (id) VALUES ('listing-1');`);
  db.exec(readFileSync(join(migrationsDir, '002_add_reservations_table.sql'), 'utf-8'));
  db.exec(readFileSync(join(migrationsDir, '012_add_guest_fingerprint.sql'), 'utf-8'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    reservation_id: 'res-1',
    listing_id: 'listing-1',
    check_in: '2026-09-09T08:00:00+00:00',
    check_out: '2026-09-10T12:00:00+00:00',
    check_in_localized: '2026-09-09',
    check_out_localized: '2026-09-10',
    nights_count: 1,
    guest_id: null,
    guest_name: 'Netlight Consulting GmbH Nina Lattke',
    guests_count: 15,
    adults_count: 15,
    children_count: null,
    infants_count: null,
    status: 'confirmed',
    confirmation_code: null,
    source: 'manual',
    platform: 'direct',
    planned_arrival: null,
    planned_departure: null,
    currency: 'EUR',
    total_price: null,
    host_payout: null,
    balance_due: null,
    total_paid: null,
    created_at_guesty: null,
    reserved_at: null,
    last_synced_at: '2026-08-14T00:00:00Z',
    internal_guest_id: null,
    guest_company: null,
    ...overrides,
  };
}

function readRow() {
  return db.prepare('SELECT guests_count, nights_count FROM reservations WHERE reservation_id = ?').get('res-1') as {
    guests_count: number | null;
    nights_count: number;
  };
}

describe('Upsert bewahrt lokale guests_count vor NULL-Überschreibung (ETL-Fall manual-Reservierung)', () => {
  it('batch-upsert mit guests_count null lässt den Bestandswert stehen', () => {
    upsertReservation(baseRow() as never);
    upsertReservationBatch([baseRow({ guests_count: null }) as never]);
    expect(readRow().guests_count).toBe(15);
  });

  it('batch-upsert mit echtem Wert überschreibt weiterhin', () => {
    upsertReservation(baseRow() as never);
    upsertReservationBatch([baseRow({ guests_count: 12 }) as never]);
    expect(readRow().guests_count).toBe(12);
  });

  it('einzel-upsert mit guests_count null lässt den Bestandswert stehen', () => {
    upsertReservation(baseRow() as never);
    upsertReservation(baseRow({ guests_count: null }) as never);
    expect(readRow().guests_count).toBe(15);
  });
});
