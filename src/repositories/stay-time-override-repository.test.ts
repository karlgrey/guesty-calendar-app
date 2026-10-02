// #799: Zeit-Abweichungen pro Aufenthalt (Migration 035)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  upsertOverride, getOverride, deleteOverride, getOverridesForReservations,
} from './stay-time-override-repository.js';

let db: Database.Database;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(migrationsDir, '035_add_stay_time_overrides.sql'), 'utf-8'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('stay-time-override-repository', () => {
  it('legt einen Override an und liest ihn', () => {
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', blockNextDay: true, note: 'Chat', source: 'agent' });
    const o = getOverride('r1')!;
    expect(o).toMatchObject({
      reservationId: 'r1', plannedArrival: null, plannedDeparture: '18:00',
      blockNextDay: true, note: 'Chat', source: 'agent',
    });
    expect(o.createdAt).toBeTruthy();
  });

  it('getOverride liefert null ohne Zeile', () => {
    expect(getOverride('nix')).toBeNull();
  });

  it('Teil-Update: nicht übergebene Felder bleiben erhalten', () => {
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', note: 'a', source: 'agent' });
    upsertOverride({ reservationId: 'r1', plannedArrival: '14:00', source: 'admin' });
    const o = getOverride('r1')!;
    expect(o).toMatchObject({ plannedArrival: '14:00', plannedDeparture: '18:00', note: 'a', blockNextDay: false, source: 'admin' });
  });

  it('explizit null löscht das Feld', () => {
    upsertOverride({ reservationId: 'r1', plannedArrival: '14:00', plannedDeparture: '18:00', note: 'a', blockNextDay: true, source: 'agent' });
    upsertOverride({ reservationId: 'r1', plannedDeparture: null, note: null, blockNextDay: false, source: 'agent' });
    expect(getOverride('r1')).toMatchObject({ plannedArrival: '14:00', plannedDeparture: null, note: null, blockNextDay: false });
  });

  it('reservation_id ist unique (genau eine Zeile)', () => {
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', source: 'agent' });
    upsertOverride({ reservationId: 'r1', plannedDeparture: '19:00', source: 'agent' });
    expect((db.prepare('SELECT COUNT(*) c FROM stay_time_overrides').get() as { c: number }).c).toBe(1);
    expect(() => db.prepare("INSERT INTO stay_time_overrides (reservation_id, source) VALUES ('r1','agent')").run()).toThrow();
  });

  it('source wird per CHECK begrenzt', () => {
    expect(() => db.prepare("INSERT INTO stay_time_overrides (reservation_id, source) VALUES ('x','sonstwas')").run()).toThrow();
  });

  it('deleteOverride löscht und meldet ob etwas da war', () => {
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', source: 'agent' });
    expect(deleteOverride('r1')).toBe(true);
    expect(getOverride('r1')).toBeNull();
    expect(deleteOverride('r1')).toBe(false);
  });

  it('getOverridesForReservations lädt mehrere in einem Query (Map)', () => {
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', source: 'agent' });
    upsertOverride({ reservationId: 'r2', plannedArrival: '13:00', source: 'admin' });
    upsertOverride({ reservationId: 'r3', plannedArrival: '13:00', source: 'admin' });
    const m = getOverridesForReservations(['r1', 'r2', 'rX']);
    expect([...m.keys()].sort()).toEqual(['r1', 'r2']);
    expect(m.get('r2')!.plannedArrival).toBe('13:00');
    expect(getOverridesForReservations([]).size).toBe(0);
  });

  it('getOverridesForReservations hält SQLite-Variablenlimit ein (viele IDs)', () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `r${i}`);
    upsertOverride({ reservationId: 'r2000', plannedArrival: '13:00', source: 'agent' });
    expect(getOverridesForReservations(ids).size).toBe(1);
  });
});
