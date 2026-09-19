import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySvixSignature } from './guesty-webhook-signature.js';

const secretRaw = Buffer.from('supersecretkey1234567890');
const secret = `whsec_${secretRaw.toString('base64')}`;
const body = '{"event":"reservation.messageReceived"}';
const ts = '1758300000';
const sig = (b: string, t = ts) => `v1,${createHmac('sha256', secretRaw).update(`msg_1.${t}.${b}`).digest('base64')}`;

describe('verifySvixSignature', () => {
  const base = { secret, msgId: 'msg_1', timestamp: ts, rawBody: body, nowSec: 1758300010 };
  it('gültig', () => expect(verifySvixSignature({ ...base, signatureHeader: sig(body) })).toBe(true));
  it('mehrere Signaturen im Header, eine passt', () => expect(verifySvixSignature({ ...base, signatureHeader: `v1,abc ${sig(body)}` })).toBe(true));
  it('manipulierter Body', () => expect(verifySvixSignature({ ...base, rawBody: body + ' ', signatureHeader: sig(body) })).toBe(false));
  it('Zeitstempel zu alt', () => expect(verifySvixSignature({ ...base, nowSec: 1758300000 + 600, signatureHeader: sig(body) })).toBe(false));
  it('Secret ohne Präfix funktioniert ebenfalls', () => expect(verifySvixSignature({ ...base, secret: secretRaw.toString('base64'), signatureHeader: sig(body) })).toBe(true));
  it('fehlender Header → false', () => expect(verifySvixSignature({ ...base, signatureHeader: '' })).toBe(false));
});
