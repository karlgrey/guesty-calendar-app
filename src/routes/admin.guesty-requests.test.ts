import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/** #772: /admin/health liefert guestyRequests; /admin/system zeigt die Tabelle. */

let statsImpl: () => unknown = () => [];
vi.mock('../services/guesty-request-telemetry.js', () => ({ getGuestyRequestDailyStats: () => statsImpl() }));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getRateLimitInfo: () => ({ remainingPerMinute: 17, limitPerMinute: 120 }) },
}));
vi.mock('../db/index.js', () => ({
  getDatabase: () => ({ prepare: () => ({ get: () => ({ name: 'listings' }) }) }),
}));
vi.mock('../jobs/sync-listing.js', () => ({ syncListing: vi.fn() }));
vi.mock('../jobs/sync-availability.js', () => ({ syncAvailability: vi.fn() }));
vi.mock('../jobs/etl-job.js', () => ({ runETLJob: vi.fn(), runETLJobForProperty: vi.fn() }));
vi.mock('../jobs/scheduler.js', () => ({ getSchedulerStatus: vi.fn().mockReturnValue({ running: false }) }));
vi.mock('../jobs/sync-analytics.js', () => ({ syncAnalytics: vi.fn() }));
vi.mock('../services/ga4-client.js', () => ({ ga4Client: {} }));
vi.mock('../services/reservation-service.js', () => ({ createOfferReservation: vi.fn() }));
vi.mock('../repositories/message-repository.js', () => ({ setManualCategory: vi.fn() }));
vi.mock('../services/document-service.js', () => ({ createOrGetDocument: vi.fn(), refreshDocument: vi.fn() }));
vi.mock('../repositories/document-repository.js', () => ({
  getDocumentsByReservation: vi.fn(), getDocumentByReservation: vi.fn(), listDocuments: vi.fn(),
  getDocumentSequenceInfo: vi.fn(), setDocumentSequenceNumber: vi.fn(),
}));

import adminRoutes from './admin.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/admin', adminRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('GET /admin/health — guestyRequests (#772)', () => {
  it('liefert today, last7Days, rateLimit', async () => {
    const days = [{ date: '2026-10-06', total: 5 }, { date: '2026-10-05', total: 9 }];
    statsImpl = () => days;
    const body = await (await fetch(`${base}/admin/health`)).json();
    expect(body.guestyRequests.today).toEqual(days[0]);
    expect(body.guestyRequests.last7Days).toEqual(days);
    expect(body.guestyRequests.rateLimit.remainingPerMinute).toBe(17);
  });

  it('bei Fehler: guestyRequests.error, Status ok', async () => {
    statsImpl = () => { throw new Error('boom'); };
    const r = await fetch(`${base}/admin/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.guestyRequests).toEqual({ error: 'boom' });
  });
});

describe('GET /admin/system — Guesty-Tabelle', () => {
  it('enthält Abschnitt, Spaltenköpfe und Remaining Minute', async () => {
    const html = await (await fetch(`${base}/admin/system`)).text();
    expect(html).toContain('Guesty-API-Requests je Tag');
    expect(html).toContain('Remaining Minute');
    expect(html).toContain('<th>Einzelabruf</th>');
    expect(html).toContain('renderGuestyRequests(data.guestyRequests)');
  });
});
