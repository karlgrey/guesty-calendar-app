// #1169: Report-Service — Zeitquelle (Override/Listing-Standard), Zeitzone, Filter (nur confirmed)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { buildPowerReport, localToUtc } from './power-report-service.js';
import { insertMeterReading } from '../repositories/meter-reading-repository.js';
import { upsertOverride } from '../repositories/stay-time-override-repository.js';

const FH = '686d1e927ae7af00234115ad';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, check_in_time TEXT, check_out_time TEXT, taxes TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);`);
  for (const m of ['002_add_reservations_table.sql', '012_add_guest_fingerprint.sql', '035_add_stay_time_overrides.sql', '036_add_stay_time_override_block_state.sql', '037_add_stay_time_override_block_date.sql', '044_add_meter_readings.sql']) {
    db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
  }
  db.prepare(`INSERT INTO listings (id, check_in_time, check_out_time) VALUES (?, '16:00', '11:00')`).run(FH);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function insertRes(id: string, checkIn: string, checkOut: string, status = 'confirmed', nights = 2) {
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, guest_name, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x')`).run(id, FH, `${checkIn}T15:00:00.000Z`, `${checkOut}T10:00:00.000Z`, checkIn, checkOut, nights, status, `Gast ${id}`);
}
/** stündliche Stände (UTC) von from bis to, 1 kWh/h */
function readings(fromIso: string, hours: number) {
  const t0 = Date.parse(fromIso);
  for (let h = 0; h <= hours; h++) insertMeterReading('farmhouse', new Date(t0 + h * 3600_000).toISOString(), 1000 + h);
}

describe('localToUtc', () => {
  it('Europe/Berlin Winter/Sommer', () => {
    expect(localToUtc('2026-11-19', '16:00', 'Europe/Berlin')).toBe('2026-11-19T15:00:00.000Z');
    expect(localToUtc('2026-07-19', '16:00', 'Europe/Berlin')).toBe('2026-07-19T14:00:00.000Z');
  });
});

describe('buildPowerReport', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');

  it('nutzt Listing-Standardzeiten in Objekt-Zeitzone und nur bestätigte Buchungen', () => {
    insertRes('a', '2026-11-01', '2026-11-03');
    insertRes('storno', '2026-11-05', '2026-11-07', 'canceled');
    insertRes('hold', '2026-11-08', '2026-11-09', 'reserved', 1);
    readings('2026-10-31T00:00:00.000Z', 24 * 5);
    const rep = buildPowerReport('farmhouse', now);
    const stays = rep.rows.filter((r) => r.kind === 'stay');
    expect(stays.map((s) => s.reservationId)).toEqual(['a']);
    // 16:00 Berlin = 15:00Z am 01.11. → 11:00 Berlin = 10:00Z am 03.11. → 43 h → 43 kWh
    expect(stays[0]).toMatchObject({ startUtc: '2026-11-01T15:00:00.000Z', endUtc: '2026-11-03T10:00:00.000Z', kwh: 43, status: 'complete' });
  });

  it('buchungsbezogene Zeit (Override) hat Vorrang', () => {
    insertRes('a', '2026-11-01', '2026-11-03');
    upsertOverride({ reservationId: 'a', plannedDeparture: '18:00', source: 'agent' });
    readings('2026-10-31T00:00:00.000Z', 24 * 5);
    const s = buildPowerReport('farmhouse', now).rows[0];
    expect(s.endUtc).toBe('2026-11-03T17:00:00.000Z');
    expect(s.kwh).toBe(50);
  });

  it('Buchungen älter als 12 Monate fallen heraus; letzter Stand wird geliefert', () => {
    insertRes('alt', '2025-10-01', '2025-10-03');
    insertRes('neu', '2026-11-01', '2026-11-03');
    readings('2026-11-18T00:00:00.000Z', 3);
    const rep = buildPowerReport('farmhouse', now);
    expect(rep.rows.filter((r) => r.kind === 'stay').map((r) => r.reservationId)).toEqual(['neu']);
    expect(rep.latestReading).toMatchObject({ measuredAt: '2026-11-18T03:00:00.000Z', kwh: 1003 });
    expect(rep.rows[0]).toMatchObject({ status: 'incomplete', incompleteReason: 'gap' });
  });

  it('ohne Stände: latestReading null', () => {
    expect(buildPowerReport('farmhouse', now).latestReading).toBeNull();
  });

  it('unbekanntes Objekt wirft', () => {
    expect(() => buildPowerReport('gibtsnicht', now)).toThrow();
  });
});
