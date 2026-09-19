// Guesty liefert Webhooks über Svix: Header svix-id, svix-timestamp, svix-signature
// ("v1,<base64> v1,<base64>"), HMAC-SHA256 über "<id>.<timestamp>.<rawBody>" mit dem
// base64-dekodierten Secret (Präfix "whsec_"). Toleranz 5 min gegen Replay.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySvixSignature(p: {
  secret: string; msgId: string; timestamp: string; signatureHeader: string; rawBody: string;
  nowSec?: number; toleranceSec?: number;
}): boolean {
  if (!p.secret || !p.msgId || !p.timestamp || !p.signatureHeader) return false;
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (p.toleranceSec ?? 300)) return false;
  const key = Buffer.from(p.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${p.msgId}.${p.timestamp}.${p.rawBody}`).digest();
  for (const part of p.signatureHeader.split(' ')) {
    const [version, b64] = part.split(',');
    if (version !== 'v1' || !b64) continue;
    const given = Buffer.from(b64, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
