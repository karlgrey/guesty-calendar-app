import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/** #772: /health/detailed liefert guestyRequests; Fehler dort lassen den Health-Check 200. */

vi.mock('../db/index.js', () => ({
  getDatabase: vi.fn().mockReturnValue({}),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  getDatabaseStats: vi.fn().mockReturnValue({}),
}));
let statsImpl: () => unknown = () => [];
const stats = { calls: [] as unknown[][] };
vi.mock('../services/guesty-request-telemetry.js', () => ({ getGuestyRequestDailyStats: (...a: unknown[]) => { stats.calls.push(a); return statsImpl(); } }));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getRateLimitInfo: vi.fn().mockReturnValue({ remainingPerMinute: 42 }) },
}));

import healthRoutes from './health.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/health', healthRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => { stats.calls = []; });

describe('GET /health/detailed — guestyRequests', () => {
  it('liefert today, last7Days und rateLimit', async () => {
    const days = [{ date: '2026-10-06', total: 5 }, { date: '2026-10-05', total: 9 }];
    statsImpl = () => days;
    const r = await fetch(`${base}/health/detailed`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(stats.calls[0]).toEqual([7]);
    expect(body.guestyRequests.today).toEqual(days[0]);
    expect(body.guestyRequests.last7Days).toEqual(days);
    expect(body.guestyRequests.rateLimit.remainingPerMinute).toBe(42);
  });

  it('bei Fehler: guestyRequests.error, Health bleibt 200', async () => {
    statsImpl = () => { throw new Error('boom'); };


    const r = await fetch(`${base}/health/detailed`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.guestyRequests).toEqual({ error: 'boom' });
  });
});
