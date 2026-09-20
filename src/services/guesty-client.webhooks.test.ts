// Fix-Runde 1 (Important #2): listWebhooks/getWebhookSecret dürfen bei unbekanntem
// Response-Shape keine Werte erfinden (leeres Array → doppelte Subscription;
// JSON.stringify(res) als "Secret" → jeder echte Webhook liefe auf 401) — fail-closed.
import { describe, it, expect, vi } from 'vitest';
import { GuestyClient } from './guesty-client.js';

function clientWithMockedRequest(result: any) {
  const client = new GuestyClient();
  const spy = vi.spyOn(client as any, 'request').mockResolvedValue(result);
  return { client, spy };
}

describe('GuestyClient webhook methods (fail-closed bei unbekanntem Shape)', () => {
  describe('listWebhooks', () => {
    it('res ist ein Array → wird direkt zurückgegeben', async () => {
      const { client } = clientWithMockedRequest([{ _id: 'w1' }]);
      expect(await client.listWebhooks()).toEqual([{ _id: 'w1' }]);
    });
    it('res.data ist ein Array → wird zurückgegeben', async () => {
      const { client } = clientWithMockedRequest({ data: [{ _id: 'w1' }] });
      expect(await client.listWebhooks()).toEqual([{ _id: 'w1' }]);
    });
    it('unbekannter Shape → wirft statt leerem Array', async () => {
      const { client } = clientWithMockedRequest({ foo: 'bar' });
      await expect(client.listWebhooks()).rejects.toThrow(/Unerwartete Antwort von \/webhooks/);
    });
  });

  describe('getWebhookSecret', () => {
    it('res.secret ist ein nicht-leerer String → wird zurückgegeben', async () => {
      const { client } = clientWithMockedRequest({ secret: 'whsec_abc' });
      expect(await client.getWebhookSecret()).toBe('whsec_abc');
    });
    it('res.data.secret ist ein nicht-leerer String → wird zurückgegeben', async () => {
      const { client } = clientWithMockedRequest({ data: { secret: 'whsec_abc' } });
      expect(await client.getWebhookSecret()).toBe('whsec_abc');
    });
    it('unbekannter Shape → wirft statt JSON.stringify(res) als Secret zu nehmen', async () => {
      const { client } = clientWithMockedRequest({ foo: 'bar' });
      await expect(client.getWebhookSecret()).rejects.toThrow(/Unerwartete Antwort von \/webhooks-v2\/secret/);
    });
    it('leerer String-Secret gilt als unbekannter Shape', async () => {
      const { client } = clientWithMockedRequest({ secret: '' });
      await expect(client.getWebhookSecret()).rejects.toThrow(/Unerwartete Antwort von \/webhooks-v2\/secret/);
    });
  });

  // Fix-Runde 2: Shape per Live-Aufruf verifiziert (Controller, 20.09.2026) —
  // GET /communication/conversations/{id} liefert { data: <Konversation> }, identisch
  // zum Listen-Shape. Trotzdem fail-closed statt eines unbrauchbaren Objekts.
  describe('getConversation', () => {
    it('res.data ist die Konversation (verifizierter Shape) → wird zurückgegeben', async () => {
      const { client } = clientWithMockedRequest({ status: 200, data: { _id: 'c1', meta: {} } });
      expect(await client.getConversation('c1')).toEqual({ _id: 'c1', meta: {} });
    });
    it('res.data.conversation (alternativer Shape) → das innere Objekt wird zurückgegeben', async () => {
      const { client } = clientWithMockedRequest({ data: { conversation: { _id: 'c1' } } });
      expect(await client.getConversation('c1')).toEqual({ _id: 'c1' });
    });
    it('res.data ohne _id → wirft statt eines unbrauchbaren Objekts', async () => {
      const { client } = clientWithMockedRequest({ status: 200, data: {} });
      await expect(client.getConversation('c1')).rejects.toThrow(/Unerwartete Antwort von \/communication\/conversations\/c1/);
    });
  });
});
