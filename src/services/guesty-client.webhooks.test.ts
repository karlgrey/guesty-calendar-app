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
});
