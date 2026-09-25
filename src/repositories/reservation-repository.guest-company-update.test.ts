import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { upsertReservation, updateGuestCompanyByGuestId } from './reservation-repository.js';

/**
 * #729 (Fall momox): PUT /api/agent/guests/:guestId mit company muss die
 * Firma sofort in ALLE bestehenden Reservierungen dieses guest_id spiegeln —
 * sonst ist der #715-Weg erst nach dem nächsten Backfill/ETL im Dashboard
 * sichtbar.
 */

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
    check_in: '2026-08-18T14:00:00+00:00',
    check_out: '2026-08-19T11:00:00+00:00',
    check_in_localized: '2026-08-18',
    check_out_localized: '2026-08-19',
    nights_count: 1,
    guest_id: 'guest-1',
    guest_name: 'Lenia Karallus',
    guests_count: 1,
    adults_count: 1,
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
    last_synced_at: '2026-09-25T00:00:00Z',
    internal_guest_id: null,
    guest_company: null,
    ...overrides,
  };
}

function readCompany(reservationId: string) {
  return (
    db.prepare('SELECT guest_company FROM reservations WHERE reservation_id = ?').get(reservationId) as {
      guest_company: string | null;
    }
  ).guest_company;
}

describe('updateGuestCompanyByGuestId (#729)', () => {
  it('setzt guest_company für alle Reservierungen des guest_id', () => {
    upsertReservation(baseRow() as never);
    upsertReservation(baseRow({ reservation_id: 'res-2' }) as never);
    upsertReservation(baseRow({ reservation_id: 'res-3', guest_id: 'guest-other' }) as never);

    const changed = updateGuestCompanyByGuestId('guest-1', 'momox SE');

    expect(changed).toBe(2);
    expect(readCompany('res-1')).toBe('momox SE');
    expect(readCompany('res-2')).toBe('momox SE');
    expect(readCompany('res-3')).toBeNull(); // anderer Gast, unangetastet
  });

  it('company: null löscht die Firma wieder (Guesty erlaubt das Leeren des Felds)', () => {
    upsertReservation(baseRow({ guest_company: 'Alte Firma GmbH' }) as never);

    updateGuestCompanyByGuestId('guest-1', null);

    expect(readCompany('res-1')).toBeNull();
  });

  it('unbekannte guest_id → 0 betroffene Zeilen, kein Fehler', () => {
    upsertReservation(baseRow() as never);
    const changed = updateGuestCompanyByGuestId('guest-does-not-exist', 'Irgendwas GmbH');
    expect(changed).toBe(0);
  });
});
