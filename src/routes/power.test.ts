import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import powerRoutes, { renderPowerPage } from './power.js';
import type { PowerReport } from '../services/power-report-service.js';
import type { PowerRow } from '../services/power-consumption.js';

const NOW = '2026-11-19T12:00:00.000Z';

function stay(over: Partial<PowerRow> = {}): PowerRow {
  return {
    kind: 'stay', reservationId: 'r1', guestName: 'Meier', checkInDate: '2026-11-10', checkOutDate: '2026-11-13',
    startUtc: '2026-11-10T07:00:00.000Z', endUtc: '2026-11-13T11:00:00.000Z', nights: 3, days: 3.17,
    status: 'complete', incompleteReason: null, kwh: 60, kwhPerNight: 20, kwhPerDay: null, deviationPct: 0, flagged: false, ...over,
  };
}
function vacancy(over: Partial<PowerRow> = {}): PowerRow {
  return {
    kind: 'vacancy', reservationId: null, guestName: null, checkInDate: null, checkOutDate: null,
    startUtc: '2026-11-13T11:00:00.000Z', endUtc: '2026-11-15T07:00:00.000Z', nights: null, days: 1.83,
    status: 'complete', incompleteReason: null, kwh: 11, kwhPerNight: null, kwhPerDay: 6, deviationPct: null, flagged: false, ...over,
  };
}
function report(over: Partial<PowerReport> = {}): PowerReport {
  return {
    rows: [stay()], medianKwhPerNight: 20, comparisonCount: 6, flaggingActive: true,
    propertySlug: 'farmhouse', propertyName: 'Farmhouse Prasser', timezone: 'Europe/Berlin',
    latestReading: { measuredAt: '2026-11-19T11:00:00.000Z', kwh: 1234.56, receivedAt: '2026-11-19T11:01:00.000Z' },
    generatedAt: NOW, ...over,
  };
}

describe('renderPowerPage', () => {
  it('Überschrift, letzter Stand in Objekt-Zeitzone, Median', () => {
    const html = renderPowerPage(report());
    expect(html).toContain('Stromverbrauch · Farmhouse Prasser');
    expect(html).toContain('Letzter Zählerstand: 19.11.2026 12:00 (1.234,6 kWh)');
    expect(html).toContain('Median: 20 kWh/Nacht aus 6 vollständig erfassten Buchungen');
    expect(html).not.toContain('Markierung ab 5 Vergleichsbuchungen');
    expect(html).not.toContain('Lieferung ausgefallen');
    expect(html).toContain('10.11.–13.11.2026');
  });

  it('(a) kein Zählerstand', () => {
    expect(renderPowerPage(report({ latestReading: null }))).toContain('Noch kein Zählerstand empfangen');
  });

  it('(b) Stand älter als 3 h -> Warnhinweis', () => {
    const html = renderPowerPage(report({ latestReading: { measuredAt: '2026-11-19T07:00:00.000Z', kwh: 10, receivedAt: 'x' } }));
    expect(html).toContain('Lieferung ausgefallen? Letzter Stand vor 5 Stunden');
  });

  it('(c) flagged-Zeile', () => {
    const html = renderPowerPage(report({ rows: [stay({ flagged: true, kwhPerNight: 32, deviationPct: 62 })] }));
    expect(html).toContain('pw-flagged');
    expect(html).toContain('auffällig');
    expect(html).toContain('+62 %');
  });

  it('negative Abweichung mit Minuszeichen', () => {
    expect(renderPowerPage(report({ rows: [stay({ deviationPct: -10 })] }))).toContain('−10 %');
  });

  it('(d) unvollständig gap/reset', () => {
    const gap = renderPowerPage(report({ rows: [stay({ status: 'incomplete', incompleteReason: 'gap', kwh: null, kwhPerNight: null, deviationPct: null })] }));
    expect(gap).toContain('unvollständig (Messlücke)');
    expect(gap).toContain('pw-incomplete');
    expect(gap).toContain('<td class="pw-num">—</td>');
    const reset = renderPowerPage(report({ rows: [stay({ status: 'incomplete', incompleteReason: 'reset', kwh: null, kwhPerNight: null })] }));
    expect(reset).toContain('unvollständig (Zählerstand gesunken)');
  });

  it('laufende Zeile', () => {
    expect(renderPowerPage(report({ rows: [stay({ status: 'running' })] }))).toContain('läuft (bis letzter Stand)');
    const html = renderPowerPage(report({ rows: [vacancy({ status: 'running' })] }));
    expect(html).toContain('seit 13.11.2026');
  });

  it('(e) Leerstand mit kWh/Tag', () => {
    const html = renderPowerPage(report({ rows: [vacancy()] }));
    expect(html).toContain('Leerstand');
    expect(html).toContain('1,8 Tage');
    expect(html).toContain('6/Tag');
    expect(html).toContain('pw-vacancy');
    expect(html).toContain('13.11.–15.11.2026');
  });

  it('(f) neueste Zeile zuerst', () => {
    const html = renderPowerPage(report({ rows: [stay({ guestName: 'Alt' }), vacancy(), stay({ guestName: 'Neu' })] }));
    expect(html.indexOf('Neu')).toBeLessThan(html.indexOf('Leerstand</td>'));
    expect(html.indexOf('Leerstand</td>')).toBeLessThan(html.indexOf('Alt'));
  });

  it('(g) Gastname wird escaped', () => {
    const html = renderPowerPage(report({ rows: [stay({ guestName: '<script>alert(1)</script>' })] }));
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('(h) flaggingActive=false', () => {
    expect(renderPowerPage(report({ flaggingActive: false, comparisonCount: 2 }))).toContain('Markierung ab 5 Vergleichsbuchungen');
  });

  it('Gast fehlt -> Gedankenstrich', () => {
    expect(renderPowerPage(report({ rows: [stay({ guestName: null })] }))).toContain('<td>—</td>');
  });
});

describe('GET /admin/strom (Route, In-Memory-DB)', () => {
  let server: Server; let base: string; let db: Database.Database;
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

  beforeAll(async () => {
    const app = express();
    app.use('/', powerRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => server.close());

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, check_in_time TEXT, check_out_time TEXT, taxes TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);`);
    for (const m of ['002_add_reservations_table.sql', '012_add_guest_fingerprint.sql', '035_add_stay_time_overrides.sql', '036_add_stay_time_override_block_state.sql', '037_add_stay_time_override_block_date.sql', '044_add_meter_readings.sql']) {
      db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
    }
    setDatabase(db);
  });
  afterEach(() => { resetDatabase(); db.close(); });

  it('200 mit Überschrift', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Stromverbrauch');
    expect(html).toContain('Noch kein Zählerstand empfangen');
  });

  it('unbekannter Slug -> 404', async () => {
    const r = await fetch(`${base}/?property=gibtsnicht`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('gibtsnicht');
  });
});
