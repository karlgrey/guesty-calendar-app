import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostexClient } from './hostex-client.js';
import fixture from '../test-fixtures/hostex/listings.json';

function envelope(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ request_id: 'r', error_code: 200, error_msg: 'Done.', data }) };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('HostexClient.getListings (#983)', () => {
  it('GET /listings mit limit/offset, liefert die Listings inkl. Beschreibungen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(fixture.data));
    vi.stubGlobal('fetch', fetchMock);
    const c = new HostexClient('tok', 'https://example.test/v3');
    const listings = await c.getListings();
    expect(listings).toHaveLength(fixture.data.listings.length);
    expect(listings[0].metadata?.descriptions?.[0].description).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://example.test/v3/listings?limit=100&offset=0');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('paginiert, solange eine volle Seite kommt', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, listing_id: `l${i}`, channel_type: 'airbnb' }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ listings: full, total: 101 }))
      .mockResolvedValueOnce(envelope({ listings: [{ id: 100, listing_id: 'l100', channel_type: 'airbnb' }], total: 101 }));
    vi.stubGlobal('fetch', fetchMock);
    const listings = await new HostexClient('tok', 'https://example.test/v3').getListings();
    expect(listings).toHaveLength(101);
    expect(String(fetchMock.mock.calls[1][0])).toContain('offset=100');
  });

  it('stoppt, sobald die gemeldete Gesamtzahl erreicht ist (volle letzte Seite, kein Endlos-Abruf)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, listing_id: `l${i}`, channel_type: 'airbnb' }));
    const fetchMock = vi.fn().mockResolvedValue(envelope({ listings: full, total: 100 }));
    vi.stubGlobal('fetch', fetchMock);
    const listings = await new HostexClient('tok', 'https://example.test/v3').getListings();
    expect(listings).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
