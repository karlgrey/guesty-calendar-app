// Guesty-Webhook reservation.messageReceived (Spec 3.1): Signatur prüfen, sofort 202,
// Verarbeitung asynchron. Muss mit express.raw() VOR express.json() gemountet sein (app.ts).
import express from 'express';
import { verifySvixSignature } from '../services/guesty-webhook-signature.js';
import logger from '../utils/logger.js';

export interface GuestyMessageWebhook {
  event: string; reservationId?: string;
  conversation: { _id: string; conversationWith?: string; meta?: any };
  message: { type?: string; body?: string; module?: string };
}
export function createGuestyWebhookRouter(deps: { secret?: string; handleInbound: (p: GuestyMessageWebhook) => Promise<void> }) {
  const router = express.Router();
  router.post('/', (req, res) => {
    if (!deps.secret) { res.status(503).json({ error: 'Webhook nicht konfiguriert (GUESTY_WEBHOOK_SECRET)' }); return; }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const ok = verifySvixSignature({
      secret: deps.secret, msgId: String(req.header('svix-id') ?? ''), timestamp: String(req.header('svix-timestamp') ?? ''),
      signatureHeader: String(req.header('svix-signature') ?? ''), rawBody,
    });
    if (!ok) { logger.warn({ ip: req.ip }, 'guesty-webhook: ungültige Signatur'); res.status(401).json({ error: 'Ungültige Signatur' }); return; }
    let payload: GuestyMessageWebhook;
    try { payload = JSON.parse(rawBody); } catch { res.status(400).json({ error: 'Kein JSON' }); return; }
    res.status(202).json({ ok: true });
    const isGuest = (payload.conversation?.conversationWith ?? 'Guest') === 'Guest' && payload.message?.type === 'fromGuest';
    if (!isGuest || !payload.conversation?._id) return;
    setImmediate(() => {
      deps.handleInbound(payload).catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err), conversationId: payload.conversation._id }, 'guesty-webhook: Verarbeitung fehlgeschlagen'));
    });
  });
  return router;
}
