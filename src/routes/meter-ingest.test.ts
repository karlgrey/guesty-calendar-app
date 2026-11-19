// #1169: Zählerstand-Annahme — Auth, Idempotenz, Validierung (Route + In-Memory-DB)
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

const TOKEN = 'm'.repeat(48);
const AGENT_KEY = 'k'.repeat(40);
const cfg = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  const config = { ...mod.config, agentApiKey: 'k'.repeat(40), agentApiKeySet: ['k'.repeat(40)] };
  Object.defineProperty(config, 'meterIngestToken', { get: () => cfg.token, enumerable: true });
  return { ...mod, config };
});

import meterIngestRoutes from './meter-ingest.js';
import { getLatestMeterReading, getMeterReadings } from '../repositories/meter-reading-repository.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
let server: Server; let base: string; let db: Database.Database;

beforeAll(async () => {
  const app = express();
  app.use('/api/meter', meterIngestRoutes);
  app.use(express.json());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  cfg.token = TOKEN;
  db = new Database(':memory:');
  db.exec(readFileSync(join(migrationsDir, '044_add_meter_readings.sql'), 'utf-8'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM meter_readings').get() as { n: number }).n;
const post = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  fetch(`${base}/api/meter/readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const valid = { slug: 'farmhouse', kwh: 12345.678, measuredAt: '2026-11-19T10:00:00+01:00' };

describe('POST /api/meter/readings — Auth', () => {
  it('ohne Token → 401, nichts gespeichert', async () => {
    const r = await post(valid, {});
    expect(r.status).toBe(401);
    expect(count()).toBe(0);
  });
  it('falsches Token → 401', async () => {
    const r = await post(valid, { Authorization: `Bearer ${'x'.repeat(48)}` });
    expect(r.status).toBe(401);
    expect(count()).toBe(0);
  });
  it('Agent-API-Key schaltet den Endpunkt NICHT frei (weder als Bearer noch als X-Agent-Key)', async () => {
    expect((await post(valid, { Authorization: `Bearer ${AGENT_KEY}` })).status).toBe(401);
    expect((await post(valid, { 'X-Agent-Key': AGENT_KEY })).status).toBe(401);
    expect(count()).toBe(0);
  });
  it('Token nicht konfiguriert → 503', async () => {
    cfg.token = undefined;
    const r = await post(valid);
    expect(r.status).toBe(503);
    expect(count()).toBe(0);
  });
  it('gültiges Token → 201 und Stand gespeichert (UTC-normalisiert)', async () => {
    const r = await post(valid);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ok: true, stored: true, slug: 'farmhouse', measuredAt: '2026-11-19T09:00:00.000Z', kwh: 12345.678 });
    expect(getLatestMeterReading('farmhouse')).toMatchObject({ measuredAt: '2026-11-19T09:00:00.000Z', kwh: 12345.678 });
  });
});

describe('POST /api/meter/readings — Idempotenz', () => {
  it('derselbe Zeitpunkt zweimal → kein zweiter Eintrag, erster Wert bleibt', async () => {
    expect((await post(valid)).status).toBe(201);
    const r2 = await post({ ...valid, kwh: 99999 });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, stored: false, duplicate: true });
    expect(count()).toBe(1);
    expect(getLatestMeterReading('farmhouse')!.kwh).toBe(12345.678);
  });
  it('derselbe Zeitpunkt in anderer Offset-Schreibweise ist eine Dublette', async () => {
    await post(valid);
    const r = await post({ ...valid, measuredAt: '2026-11-19T09:00:00Z' });
    expect(r.status).toBe(200);
    expect(count()).toBe(1);
  });
  it('anderer Zeitpunkt → neuer Eintrag', async () => {
    await post(valid);
    await post({ ...valid, measuredAt: '2026-11-19T11:00:00+01:00', kwh: 12346.1 });
    expect(getMeterReadings('farmhouse', '2026-11-19T00:00:00.000Z', '2026-11-20T00:00:00.000Z')).toHaveLength(2);
  });
});

describe('POST /api/meter/readings — Validierung', () => {
  const cases: Array<[string, unknown, number]> = [
    ['unbekannter Slug', { ...valid, slug: 'gibtsnicht' }, 404],
    ['Slug fehlt', { kwh: 1, measuredAt: valid.measuredAt }, 400],
    ['kwh fehlt', { slug: 'farmhouse', measuredAt: valid.measuredAt }, 400],
    ['kwh negativ', { ...valid, kwh: -1 }, 400],
    ['kwh kein Zahlwert', { ...valid, kwh: 'unavailable' }, 400],
    ['kwh null', { ...valid, kwh: null }, 400],
    ['measuredAt ohne Zeitzone', { ...valid, measuredAt: '2026-11-19T10:00:00' }, 400],
    ['measuredAt nur Datum', { ...valid, measuredAt: '2026-11-19' }, 400],
    ['measuredAt ungültig', { ...valid, measuredAt: '2026-13-45T10:00:00Z' }, 400],
    ['measuredAt in der Zukunft', { ...valid, measuredAt: new Date(Date.now() + 3600_000).toISOString() }, 400],
    ['unbekanntes Feld', { ...valid, unit: 'kWh' }, 400],
    ['Array statt Objekt', [valid], 400],
    ['kaputtes JSON', '{"slug": "farmhouse", ', 400],
  ];
  for (const [name, body, status] of cases) {
    it(`${name} → ${status}, nichts gespeichert`, async () => {
      const r = await post(body);
      expect(r.status).toBe(status);
      expect(count()).toBe(0);
    });
  }
  it('kwh als Zahl-String wird akzeptiert (HA-Template-Fall)', async () => {
    const r = await post({ ...valid, kwh: '12345.5' });
    expect(r.status).toBe(201);
    expect(getLatestMeterReading('farmhouse')!.kwh).toBe(12345.5);
  });
  it('Zeitpunkt mit Millisekunden und Z', async () => {
    expect((await post({ ...valid, measuredAt: '2026-11-19T09:00:00.123Z' })).status).toBe(201);
  });
});
