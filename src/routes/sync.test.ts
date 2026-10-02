// #767: POST /sync/* war ohne Auth erreichbar — jetzt Agent-Key ODER Admin-Session.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

const KEY = 'test-agent-key-0123456789abcdef0123456789';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  // Literal statt KEY: vi.mock wird gehoistet, Konstanten sind hier noch nicht initialisiert
  return { ...mod, config: { ...mod.config, agentApiKeySet: ['test-agent-key-0123456789abcdef0123456789'] } };
});
const runETLJobMock = vi.fn();
vi.mock('../jobs/etl-job.js', () => ({ runETLJob: (...args: unknown[]) => runETLJobMock(...args) }));
vi.mock('../jobs/sync-listing.js', () => ({
  syncConfiguredListing: vi.fn().mockResolvedValue({ success: true, skipped: false }),
}));
vi.mock('../jobs/sync-availability.js', () => ({
  syncConfiguredAvailability: vi.fn().mockResolvedValue({ success: true, skipped: false }),
}));
vi.mock('../jobs/scheduler.js', () => ({ getSchedulerStatus: vi.fn().mockReturnValue({ running: true }) }));

import syncRoutes from './sync.js';

let server: Server;
let base: string;
let authenticated = false;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Passport-Ersatz: der Test steuert req.isAuthenticated()
  app.use((req, _res, next) => { (req as any).isAuthenticated = () => authenticated; next(); });
  app.use('/sync', syncRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(undefined))));
beforeEach(() => {
  authenticated = false;
  runETLJobMock.mockReset().mockResolvedValue({ success: true });
});

const post = (p: string, key?: string) =>
  fetch(`${base}${p}`, { method: 'POST', headers: key ? { 'X-Agent-Key': key } : {} });

describe('/sync Auth (#767)', () => {
  it('POST /sync/all ohne Key → 401, kein ETL-Lauf', async () => {
    const res = await post('/sync/all');
    expect(res.status).toBe(401);
    expect(runETLJobMock).not.toHaveBeenCalled();
  });

  it('POST /sync/all mit falschem Key → 401', async () => {
    expect((await post('/sync/all', 'wrong-key-wrong-key-wrong-key-wrong')).status).toBe(401);
    expect(runETLJobMock).not.toHaveBeenCalled();
  });

  it('POST /sync/listing und /sync/availability ohne Key → 401', async () => {
    expect((await post('/sync/listing')).status).toBe(401);
    expect((await post('/sync/availability')).status).toBe(401);
  });

  it('GET /sync/status ohne Key → 401 (ganzer Router geschützt)', async () => {
    expect((await fetch(`${base}/sync/status`)).status).toBe(401);
  });

  it('POST /sync/all mit gültigem Key → 200, force aus Query', async () => {
    const res = await post('/sync/all?force=true', KEY);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(runETLJobMock).toHaveBeenCalledWith(true);
  });

  it('angemeldete Admin-Session ohne Key → 200', async () => {
    authenticated = true;
    const res = await post('/sync/all');
    expect(res.status).toBe(200);
    expect(runETLJobMock).toHaveBeenCalledWith(false);
  });
});
