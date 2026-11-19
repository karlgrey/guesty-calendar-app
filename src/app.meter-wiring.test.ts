// #1169: Verdrahtung in der echten createApp() — die Zählerstand-Annahme ist ohne Session
// erreichbar und hört nur auf das eigene Token; die Admin-Seite /admin/strom liegt hinter
// requireAuth; das Zähler-Token öffnet weder Admin noch Agent-API.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-wiring-'));
const TOKEN = 'm'.repeat(48);
const AGENT_KEY = 'k'.repeat(40);

vi.mock('./config/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config/index.js')>();
  return {
    ...mod,
    config: { ...mod.config, meterIngestToken: 'm'.repeat(48), agentApiKey: 'k'.repeat(40), agentApiKeySet: ['k'.repeat(40)] },
    getDatabasePath: () => path.join(tmpDir, 'calendar.db'),
  };
});

import { createApp } from './app.js';
import { setDatabase, resetDatabase } from './db/index.js';

let server: Server;
let base: string;
let db: Database.Database;

beforeAll(async () => {
  db = new Database(':memory:');
  const migration = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db/migrations/044_add_meter_readings.sql');
  db.exec(fs.readFileSync(migration, 'utf-8'));
  setDatabase(db);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  resetDatabase();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM meter_readings').get() as { n: number }).n;
const reading = { slug: 'farmhouse', kwh: 100.5, measuredAt: '2026-11-19T10:00:00+01:00' };
const post = (headers: Record<string, string>) =>
  fetch(`${base}/api/meter/readings`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(reading),
  });

describe('Zählerstand-Annahme in createApp() (#1169)', () => {
  it('ohne Token → 401 als JSON (kein Login-Redirect), nichts gespeichert', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(count()).toBe(0);
  });

  it('Agent-Key schaltet den Endpunkt nicht frei', async () => {
    expect((await post({ Authorization: `Bearer ${AGENT_KEY}` })).status).toBe(401);
    expect((await post({ 'X-Agent-Key': AGENT_KEY })).status).toBe(401);
    expect(count()).toBe(0);
  });

  it('eigenes Token, ohne Session → 201 und gespeichert', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(201);
    expect(count()).toBe(1);
  });
});

describe('Zähler-Token öffnet nichts anderes (#1169)', () => {
  it('GET /admin/strom ohne Session → Redirect auf Login', async () => {
    const res = await fetch(`${base}/admin/strom`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login');
  });

  it('GET /admin/strom mit Zähler-Token → trotzdem Redirect auf Login', async () => {
    const res = await fetch(`${base}/admin/strom`, { redirect: 'manual', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login');
  });

  it('Agent-API mit Zähler-Token → 401', async () => {
    const asKey = await fetch(`${base}/api/agent/reservations`, { headers: { 'X-Agent-Key': TOKEN } });
    expect(asKey.status).toBe(401);
    const asBearer = await fetch(`${base}/api/agent/reservations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(asBearer.status).toBe(401);
  });
});
