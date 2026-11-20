import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostexClient } from './hostex-client.js';
import { ExternalApiError } from '../utils/errors.js';

function stubFetch(envelope: Record<string, unknown> = { request_id: 'r', error_code: 200, error_msg: 'Done.' }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => envelope });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const client = () => new HostexClient('tok', 'https://example.test/v3');

describe('HostexClient.updateListingPrices (#1299)', () => {
  it('POST /listings/prices mit snake_case-Body', async () => {
    const f = stubFetch();
    const res = await client().updateListingPrices({
      channelType: 'airbnb', listingId: 'L1',
      prices: [{ startDate: '2026-12-01', endDate: '2026-12-10', price: 180 }],
    });
    expect(res).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://example.test/v3/listings/prices');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channel_type: 'airbnb', listing_id: 'L1',
      prices: [{ start_date: '2026-12-01', end_date: '2026-12-10', price: 180 }],
    });
  });

  it('stapelt 101 Einträge in 2 Requests (100 + 1)', async () => {
    const f = stubFetch();
    const prices = Array.from({ length: 101 }, (_, i) => ({ startDate: '2026-12-01', endDate: '2026-12-02', price: 100 + i }));
    await client().updateListingPrices({ channelType: 'airbnb', listingId: 'L1', prices });
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).prices).toHaveLength(100);
    expect(JSON.parse((f.mock.calls[1][1] as RequestInit).body as string).prices).toHaveLength(1);
  });

  it('leeres Array → kein Request', async () => {
    const f = stubFetch();
    expect(await client().updateListingPrices({ channelType: 'airbnb', listingId: 'L1', prices: [] })).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([99.5, 0, -5, NaN])('Preis %s wirft ohne Request', async (price) => {
    const f = stubFetch();
    await expect(client().updateListingPrices({
      channelType: 'airbnb', listingId: 'L1',
      prices: [{ startDate: '2026-12-01', endDate: '2026-12-02', price }],
    })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it('Envelope-Fehler wirft ExternalApiError', async () => {
    stubFetch({ request_id: 'r', error_code: 400, error_msg: 'bad' });
    await expect(client().updateListingPrices({
      channelType: 'airbnb', listingId: 'L1',
      prices: [{ startDate: '2026-12-01', endDate: '2026-12-02', price: 100 }],
    })).rejects.toBeInstanceOf(ExternalApiError);
  });
});

describe('HostexClient.updateListingRestrictions (#1299)', () => {
  it('POST /listings/restrictions, nur gesetzte Felder serialisiert', async () => {
    const f = stubFetch();
    const res = await client().updateListingRestrictions({
      channelType: 'airbnb', listingId: 'L1',
      restrictions: [
        { startDate: '2026-12-01', endDate: '2026-12-10', minStayOnArrival: 3, closedOnArrival: false, closedOnDeparture: false },
        { startDate: '2026-12-11', endDate: '2026-12-12', minStayOnArrival: 2 },
      ],
    });
    expect(res).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://example.test/v3/listings/restrictions');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channel_type: 'airbnb', listing_id: 'L1',
      restrictions: [
        { start_date: '2026-12-01', end_date: '2026-12-10', min_stay_on_arrival: 3, closed_on_arrival: false, closed_on_departure: false },
        { start_date: '2026-12-11', end_date: '2026-12-12', min_stay_on_arrival: 2 },
      ],
    });
  });

  it('stapelt 101 Einträge in 2 Requests', async () => {
    const f = stubFetch();
    const restrictions = Array.from({ length: 101 }, () => ({ startDate: '2026-12-01', endDate: '2026-12-02', minStayOnArrival: 2 }));
    await client().updateListingRestrictions({ channelType: 'airbnb', listingId: 'L1', restrictions });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('leeres Array → kein Request', async () => {
    const f = stubFetch();
    expect(await client().updateListingRestrictions({ channelType: 'airbnb', listingId: 'L1', restrictions: [] })).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });

  it('Envelope-Fehler wirft ExternalApiError', async () => {
    stubFetch({ request_id: 'r', error_code: 400, error_msg: 'bad' });
    await expect(client().updateListingRestrictions({
      channelType: 'airbnb', listingId: 'L1',
      restrictions: [{ startDate: '2026-12-01', endDate: '2026-12-02', minStayOnArrival: 2 }],
    })).rejects.toBeInstanceOf(ExternalApiError);
  });
});
