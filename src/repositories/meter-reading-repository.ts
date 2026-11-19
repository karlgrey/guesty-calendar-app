/**
 * Zählerstände je Objekt (Migration 044, #1169).
 *
 * `measuredAt` ist immer UTC-ISO (`toISOString()`), damit Stringvergleich = Zeitvergleich.
 */
import { getDatabase } from '../db/index.js';

export interface MeterReading {
  propertySlug: string;
  /** UTC-ISO, z. B. 2026-11-19T09:00:00.000Z */
  measuredAt: string;
  kwh: number;
  receivedAt: string;
}

interface Row {
  property_slug: string;
  measured_at: string;
  kwh: number;
  received_at: string;
}

const toReading = (r: Row): MeterReading => ({
  propertySlug: r.property_slug,
  measuredAt: r.measured_at,
  kwh: r.kwh,
  receivedAt: r.received_at,
});

/** Legt einen Stand an. `false` = derselbe Zeitpunkt existiert schon (nichts geändert). */
export function insertMeterReading(propertySlug: string, measuredAtUtc: string, kwh: number): boolean {
  const res = getDatabase()
    .prepare('INSERT OR IGNORE INTO meter_readings (property_slug, measured_at, kwh) VALUES (?, ?, ?)')
    .run(propertySlug, measuredAtUtc, kwh);
  return res.changes === 1;
}

/** Alle Stände eines Objekts im Fenster [fromUtc, toUtc], aufsteigend nach Messzeitpunkt. */
export function getMeterReadings(propertySlug: string, fromUtc: string, toUtc: string): MeterReading[] {
  const rows = getDatabase()
    .prepare(
      `SELECT property_slug, measured_at, kwh, received_at FROM meter_readings
       WHERE property_slug = ? AND measured_at >= ? AND measured_at <= ?
       ORDER BY measured_at ASC`,
    )
    .all(propertySlug, fromUtc, toUtc) as Row[];
  return rows.map(toReading);
}

/** Jüngster Stand nach Messzeitpunkt (für „letzter Zählerstand“ im Admin), sonst null. */
export function getLatestMeterReading(propertySlug: string): MeterReading | null {
  const row = getDatabase()
    .prepare(
      `SELECT property_slug, measured_at, kwh, received_at FROM meter_readings
       WHERE property_slug = ? ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(propertySlug) as Row | undefined;
  return row ? toReading(row) : null;
}
