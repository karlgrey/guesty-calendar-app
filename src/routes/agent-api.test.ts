import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, agentApiKey: 'test-agent-key-0123456789abcdef0123456789' } };
});
vi.mock('../services/reservation-service.js', () => ({
  createOfferReservation: vi.fn().mockResolvedValue({
    reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042',
    holdUntil: '2026-08-07', priceSource: 'manual',
  }),
  confirmOfferReservation: vi.fn().mockResolvedValue(undefined),
  releaseOfferReservation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fake'), isNew: false,
  }),
  refreshDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fresh'), isNew: false,
  }),
}));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getReservation: vi.fn().mockResolvedValue({ _id: 'res-1', status: 'reserved' }),
    updateGuest: vi.fn().mockResolvedValue(undefined),
  },
}));

import agentApiRoutes from './agent-api.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };

describe('agent-api', () => {
  it('401 ohne Key', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', body: '{}' , headers: { 'Content-Type': 'application/json' }});
    expect(r.status).toBe(401);
  });

  it('POST /reservations → 201 mit Service-Ergebnis', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ propertySlug: 'farmhouse', checkIn: '2026-09-09', checkOut: '2026-09-10', guestsCount: 15, guest: { firstName: 'N', lastName: 'L', email: 'n@x.de' }, priceGross: 2850 }),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ reservationId: 'res-1', documentNumber: 'A-2026-0042' });
  });

  it('GET /reservations/:id → Guesty-Status', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'reserved' });
  });

  it('GET /reservations/:id/offer.pdf → PDF mit Nummer im Header', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1/offer.pdf`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('x-document-number')).toBe('A-2026-0042');
  });

  it('offer.pdf?refresh=1 nutzt refreshDocument', async () => {
    const { refreshDocument, createOrGetDocument } = await import('../services/document-service.js');
    (createOrGetDocument as any).mockClear(); (refreshDocument as any).mockClear();
    const r = await fetch(`${base}/api/agent/reservations/res-1/offer.pdf?refresh=1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(refreshDocument).toHaveBeenCalledOnce();
    expect(createOrGetDocument).not.toHaveBeenCalled();
  });

  it('PUT /guests/:id → updateGuest', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ address: { city: 'Potsdam' } }),
    });
    expect(r.status).toBe(200);
    expect(guestyClient.updateGuest).toHaveBeenCalledWith('guest-1', { address: { city: 'Potsdam' } });
  });

  it('confirm + cancel → 200', async () => {
    const c = await fetch(`${base}/api/agent/reservations/res-1/confirm`, { method: 'POST', headers: KEY });
    expect(c.status).toBe(200);
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(200);
  });

  it('AppError des Service wird als Statuscode gemappt (ValidationError→400)', async () => {
    const { createOfferReservation } = await import('../services/reservation-service.js');
    const { ValidationError } = await import('../utils/errors.js');
    (createOfferReservation as any).mockRejectedValueOnce(new ValidationError('bad input'));
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', headers: KEY, body: '{}' });
    expect(r.status).toBe(400);
  });
});
