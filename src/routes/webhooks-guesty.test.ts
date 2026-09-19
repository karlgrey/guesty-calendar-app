import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createGuestyWebhookRouter } from './webhooks-guesty.js';
import logger from '../utils/logger.js';

const secretRaw = Buffer.from('k'.repeat(24));
const secret = `whsec_${secretRaw.toString('base64')}`;
const payload = { event: 'reservation.messageReceived', reservationId: 'r1', conversation: { _id: 'c1', conversationWith: 'Guest' }, message: { type: 'fromGuest', body: 'Hi' } };

async function post(app: express.Express, body: string, headers: Record<string, string>) {
  const srv = app.listen(0); const port = (srv.address() as any).port;
  try { return await fetch(`http://127.0.0.1:${port}/api/webhooks/guesty`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }); }
  finally { srv.close(); }
}
function signed(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': 'm1', 'svix-timestamp': ts, 'svix-signature': `v1,${createHmac('sha256', secretRaw).update(`m1.${ts}.${body}`).digest('base64')}` };
}
function mkApp(secret?: string, handleInbound = vi.fn().mockResolvedValue(undefined)) {
  const app = express();
  app.use('/api/webhooks/guesty', express.raw({ type: '*/*', limit: '1mb' }), createGuestyWebhookRouter({ secret, handleInbound }));
  app.use(express.json());
  return { app, handleInbound };
}

describe('POST /api/webhooks/guesty', () => {
  it('202 + Handler bei gültiger Signatur und Gastnachricht', async () => {
    const body = JSON.stringify(payload); const { app, handleInbound } = mkApp(secret);
    const res = await post(app, body, signed(body));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleInbound).toHaveBeenCalledWith(expect.objectContaining({ conversation: expect.objectContaining({ _id: 'c1' }) }));
  });
  it('loggt Annahme der Gastnachricht (Route liegt vor dem requestLogger, sonst keine Spur)', async () => {
    const body = JSON.stringify(payload); const { app } = mkApp(secret);
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      await post(app, body, signed(body));
      await new Promise((r) => setTimeout(r, 10));
      expect(infoSpy).toHaveBeenCalledWith({ conversationId: 'c1' }, 'guesty-webhook: Gastnachricht angenommen');
    } finally { infoSpy.mockRestore(); }
  });
  it('401 bei falscher Signatur', async () => {
    const body = JSON.stringify(payload); const { app, handleInbound } = mkApp(secret);
    const res = await post(app, body, { ...signed(body), 'svix-signature': 'v1,nope' });
    expect(res.status).toBe(401); expect(handleInbound).not.toHaveBeenCalled();
  });
  it('503 ohne Secret', async () => {
    const body = JSON.stringify(payload); const { app } = mkApp(undefined);
    expect((await post(app, body, signed(body))).status).toBe(503);
  });
  it('202 ohne Handler bei Host-Nachricht', async () => {
    const body = JSON.stringify({ ...payload, message: { type: 'fromHost' } }); const { app, handleInbound } = mkApp(secret);
    expect((await post(app, body, signed(body))).status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
