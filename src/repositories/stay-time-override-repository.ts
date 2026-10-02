/**
 * Zeit-Abweichungen pro Aufenthalt (Migration 035, #799).
 *
 * Plattformneutral (Guesty + Hostex): zugesagte Late-Checkouts / frühe Check-ins /
 * Folgetag-Block werden in unserer DB gehalten. Override gewinnt über die Provider-Felder
 * `reservations.planned_*`; NULL = Provider-/Standardwert gilt (effective-stay-times.ts).
 */
import { getDatabase } from '../db/index.js';

export type OverrideSource = 'agent' | 'admin' | 'etl';

/** Migration 036: NULL | 'set-by-us' (wir haben geblockt) | 'already-blocked' (Tag war schon unavailable) */
export type BlockState = 'set-by-us' | 'already-blocked';

export interface StayTimeOverride {
  reservationId: string;
  plannedArrival: string | null;
  plannedDeparture: string | null;
  blockNextDay: boolean;
  blockState: BlockState | null;
  note: string | null;
  source: OverrideSource;
  createdAt: string;
  updatedAt: string;
}

/** Teilmenge: `undefined` = Feld bleibt, `null` = Feld löschen (zurück auf Provider-Wert). */
export interface UpsertOverrideInput {
  reservationId: string;
  plannedArrival?: string | null;
  plannedDeparture?: string | null;
  blockNextDay?: boolean;
  note?: string | null;
  source: OverrideSource;
}

interface Row {
  reservation_id: string;
  planned_arrival: string | null;
  planned_departure: string | null;
  block_next_day: number;
  block_state: BlockState | null;
  note: string | null;
  source: OverrideSource;
  created_at: string;
  updated_at: string;
}

function toOverride(r: Row): StayTimeOverride {
  return {
    reservationId: r.reservation_id,
    plannedArrival: r.planned_arrival,
    plannedDeparture: r.planned_departure,
    blockNextDay: r.block_next_day === 1,
    blockState: r.block_state ?? null,
    note: r.note,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getOverride(reservationId: string): StayTimeOverride | null {
  const row = getDatabase()
    .prepare('SELECT * FROM stay_time_overrides WHERE reservation_id = ?')
    .get(reservationId) as Row | undefined;
  return row ? toOverride(row) : null;
}

export function upsertOverride(input: UpsertOverrideInput): StayTimeOverride {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const cur = getOverride(input.reservationId);
    const pick = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);
    const merged = {
      plannedArrival: pick(input.plannedArrival, cur?.plannedArrival ?? null),
      plannedDeparture: pick(input.plannedDeparture, cur?.plannedDeparture ?? null),
      blockNextDay: pick(input.blockNextDay, cur?.blockNextDay ?? false),
      note: pick(input.note, cur?.note ?? null),
    };
    db.prepare(`
      INSERT INTO stay_time_overrides (reservation_id, planned_arrival, planned_departure, block_next_day, note, source)
      VALUES (@id, @arrival, @departure, @block, @note, @source)
      ON CONFLICT(reservation_id) DO UPDATE SET
        planned_arrival = excluded.planned_arrival,
        planned_departure = excluded.planned_departure,
        block_next_day = excluded.block_next_day,
        note = excluded.note,
        source = excluded.source,
        updated_at = datetime('now')
    `).run({
      id: input.reservationId,
      arrival: merged.plannedArrival,
      departure: merged.plannedDeparture,
      block: merged.blockNextDay ? 1 : 0,
      note: merged.note,
      source: input.source,
    });
  });
  tx();
  return getOverride(input.reservationId)!;
}

/** Block-Zustand setzen/zurücksetzen (null). true = Zeile existiert. */
export function setBlockState(reservationId: string, state: BlockState | null): boolean {
  return getDatabase()
    .prepare("UPDATE stay_time_overrides SET block_state = ?, updated_at = datetime('now') WHERE reservation_id = ?")
    .run(state, reservationId).changes > 0;
}

/** true = es gab einen Override (und er ist jetzt weg). */
export function deleteOverride(reservationId: string): boolean {
  return getDatabase().prepare('DELETE FROM stay_time_overrides WHERE reservation_id = ?').run(reservationId).changes > 0;
}

/** Ein Query (in Chunks unterhalb des SQLite-Variablenlimits) für den Kalender-Sync. */
export function getOverridesForReservations(ids: string[]): Map<string, StayTimeOverride> {
  const out = new Map<string, StayTimeOverride>();
  if (ids.length === 0) return out;
  const db = getDatabase();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT * FROM stay_time_overrides WHERE reservation_id IN (${part.map(() => '?').join(',')})`)
      .all(...part) as Row[];
    for (const r of rows) out.set(r.reservation_id, toOverride(r));
  }
  return out;
}
