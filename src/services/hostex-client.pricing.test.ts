import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostexClient, HOSTEX_RESERVATION_WINDOW_DAYS } from './hostex-client.js';
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

describe('HostexClient.getReservations Fenster (#1305)', () => {
  type Res = { reservation_code?: string; id?: string; check_in_date: string };
  const OK = { request_id: 'r', error_code: 200, error_msg: 'Done.' };

  /** fetch-Mock: liefert je Request-URL die passenden Reservierungen (limit/offset/Fenster beachtet). */
  function stubReservations(all: Res[], failOnCall?: number) {
    const f = vi.fn().mockImplementation(async (url: unknown) => {
      if (failOnCall !== undefined && f.mock.calls.length === failOnCall) {
        return { ok: true, status: 200, json: async () => ({ request_id: 'r', error_code: 400, error_msg: 'The check-in range cannot exceed 180 days.' }) };
      }
      const p = new URL(String(url)).searchParams;
      const s = p.get('start_check_in_date');
      const e = p.get('end_check_in_date');
      const limit = Number(p.get('limit'));
      const offset = Number(p.get('offset'));
      const hits = all.filter((r) => (!s || r.check_in_date >= s) && (!e || r.check_in_date <= e));
      return { ok: true, status: 200, json: async () => ({ ...OK, data: { reservations: hits.slice(offset, offset + limit) } }) };
    });
    vi.stubGlobal('fetch', f);
    return f;
  }
  const windows = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls
      .map((c) => new URL(String(c[0])).searchParams)
      .filter((p) => p.get('offset') === '0')
      .map((p) => [p.get('start_check_in_date'), p.get('end_check_in_date')]);

  it('Konstante ist 180', () => {
    expect(HOSTEX_RESERVATION_WINDOW_DAYS).toBe(180);
  });

  it('genau 180 Tage (2027-01-01..2027-06-29) → 1 Aufruf', async () => {
    const f = stubReservations([]);
    await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-06-29' });
    expect(f).toHaveBeenCalledTimes(1);
    const p = new URL(String(f.mock.calls[0][0])).searchParams;
    expect(p.get('start_check_in_date')).toBe('2027-01-01');
    expect(p.get('end_check_in_date')).toBe('2027-06-29');
  });

  it('181 Tage → 2 Fenster 01-01..06-29 und 06-30..06-30', async () => {
    const f = stubReservations([]);
    await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-06-30' });
    expect(windows(f)).toEqual([['2027-01-01', '2027-06-29'], ['2027-06-30', '2027-06-30']]);
  });

  it('273 Tage (2027-01-01..2027-09-30) → 2 Fenster mit exakten Grenzen', async () => {
    const f = stubReservations([]);
    await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-09-30' });
    expect(windows(f)).toEqual([['2027-01-01', '2027-06-29'], ['2027-06-30', '2027-09-30']]);
  });

  it('850 Tage → 5 lückenlose Fenster, letztes endet auf endCheckIn', async () => {
    const f = stubReservations([]);
    await client().getReservations({ startCheckIn: '2026-01-01', endCheckIn: '2028-04-29' }); // 850 Tage inklusive
    const w = windows(f);
    expect(w).toHaveLength(5);
    expect(w[0][0]).toBe('2026-01-01');
    expect(w[4][1]).toBe('2028-04-29');
    const day = (s: string | null) => Date.parse(`${s}T00:00:00Z`) / 86400000;
    for (let i = 0; i < w.length; i++) {
      expect(day(w[i][1]) - day(w[i][0]) + 1).toBeLessThanOrEqual(180);
      if (i > 0) expect(day(w[i][0])).toBe(day(w[i - 1][1]) + 1);
    }
  });

  it('Duplikat über zwei Fenster wird einmal geliefert, Reihenfolge stabil', async () => {
    // Server liefert dieselbe Reservierung in beiden Fenstern (z. B. Randverhalten)
    const dup = { reservation_code: 'A', check_in_date: '2027-06-29' };
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...OK, data: { reservations: [{ reservation_code: 'X', check_in_date: '2027-01-02' }, dup] } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...OK, data: { reservations: [dup, { reservation_code: 'Y', check_in_date: '2027-06-30' }] } }) });
    vi.stubGlobal('fetch', f);
    const res = await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-06-30' });
    expect(res.map((r) => r.reservation_code)).toEqual(['X', 'A', 'Y']);
  });

  it('Dedup-Fallback auf id; ohne code und id wird nicht dedupliziert', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...OK, data: { reservations: [{ id: '7' }, { check_in_date: 'a' }] } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...OK, data: { reservations: [{ id: '7' }, { check_in_date: 'a' }] } }) });
    vi.stubGlobal('fetch', f);
    const res = await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-06-30' });
    expect(res).toHaveLength(3);
  });

  it('ohne endCheckIn unverändert 1 Aufruf, ohne Grenzparameter', async () => {
    const f = stubReservations([]);
    await client().getReservations({ propertyId: 'P1', startCheckIn: '2020-01-01' });
    expect(f).toHaveBeenCalledTimes(1);
    const p = new URL(String(f.mock.calls[0][0])).searchParams;
    expect(p.get('start_check_in_date')).toBe('2020-01-01');
    expect(p.get('end_check_in_date')).toBeNull();
    expect(p.get('property_id')).toBe('P1');
  });

  it('start > end wird wie bisher durchgereicht (1 Aufruf)', async () => {
    const f = stubReservations([]);
    await client().getReservations({ startCheckIn: '2027-02-01', endCheckIn: '2027-01-01' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('Paginierung im Fenster (100 + 1) funktioniert weiter', async () => {
    const rows: Res[] = Array.from({ length: 101 }, (_, i) => ({ reservation_code: `R${i}`, check_in_date: '2027-01-05' }));
    const f = stubReservations(rows);
    const res = await client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-01-31' });
    expect(res).toHaveLength(101);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new URL(String(f.mock.calls[1][0])).searchParams.get('offset')).toBe('100');
  });

  it('Fehler im zweiten Fenster wirft ExternalApiError (kein Teil-Ergebnis)', async () => {
    stubReservations([{ reservation_code: 'A', check_in_date: '2027-01-05' }], 1);
    await expect(client().getReservations({ startCheckIn: '2027-01-01', endCheckIn: '2027-09-30' }))
      .rejects.toBeInstanceOf(ExternalApiError);
  });
});
