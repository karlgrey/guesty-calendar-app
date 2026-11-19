// #1099: Lesewege auf Reservations v3 (fetch-Mock, anonymisierte Live-Fixtures).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { GuestyClient, ALL_RESERVATION_STATUSES } from './guesty-client.js';
import { ExternalApiError } from '../utils/errors.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/guesty-v3');
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const CASES = ['manual', 'airbnb'] as const;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
function newClient(): any {
  vi.spyOn(GuestyClient.prototype as any, 'loadCachedToken').mockImplementation(() => {});
  vi.spyOn(GuestyClient.prototype as any, 'saveCachedToken').mockImplementation(() => {});
  const c: any = new GuestyClient('https://api.example/v1', 'https://auth.example/token', 'cid', 'secret');
  c.accessToken = 'tok';
  c.tokenExpiresAt = Date.now() + 24 * 3600 * 1000;
  return c;
}

type Routes = {
  byIds?: () => Response;
  payments?: () => Response;
  guest?: () => Response;
  search?: () => Response;
};
function route(r: Routes) {
  fetchMock.mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes('/reservations-v3/search?')) return r.search!();
    if (u.includes('/reservations-v3?')) return r.byIds!();
    if (u.includes('/payments?')) return r.payments!();
    if (u.includes('/guests-crud/')) return r.guest!();
    throw new Error(`unerwartete URL ${u}`);
  });
}
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixtureRoutes(kind: (typeof CASES)[number]): Routes {
  return {
    byIds: () => jsonResponse(200, load(`v3-by-ids-${kind}.json`)),
    payments: () => jsonResponse(200, load(`payments-${kind}.json`)),
    guest: () => jsonResponse(200, load(`guests-crud-${kind}.json`)),
  };
}

describe.each(CASES)('getReservation (%s)', (kind) => {
  const legacy = load(`legacy-get-${kind}.json`);
  const id = legacy._id as string;

  it('a) 3 Aufrufe (by-ids, payments, guest), Ergebnis wertgleich zu Legacy', async () => {
    route(fixtureRoutes(kind));
    const client = newClient();
    const r = await client.getReservation(id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const byIds = urls().find((u) => u.includes('/reservations-v3?'))!;
    expect(byIds).toContain(`reservationIds[]=${id}`);
    expect(byIds).not.toContain('reservationIds=');
    expect(r.checkIn).toBe(legacy.checkIn);
    expect(r.checkOut).toBe(legacy.checkOut);
    expect(r.listingId).toBe(legacy.listingId);
    expect(r.plannedArrival).toBe(legacy.plannedArrival);
    expect(r.guestsCount).toBe(legacy.guestsCount);
    expect(r.guestId).toBe(legacy.guestId);
    expect(r.guest.fullName).toBe(legacy.guest.fullName);
    expect(r.money.balanceDue).toBe(legacy.money.balanceDue);
    expect(r.money.totalPaid).toBe(legacy.money.totalPaid);
    expect(r.money.hostPayout).toBe(legacy.money.hostPayout);
    // i) Telemetrie
    expect(client.getRequestCounters().total).toBe(3);
  });

  it('b) payments:false, guest:false → 1 Aufruf, kein guest, kein balanceDue', async () => {
    route(fixtureRoutes(kind));
    const r = await newClient().getReservation(id, { payments: false, guest: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.guest).toBeUndefined();
    expect(r.money.balanceDue).toBeUndefined();
  });

  it('d) payments 500 → kein Wurf, ohne balanceDue, Kernfelder da', async () => {
    route({ ...fixtureRoutes(kind), payments: () => jsonResponse(500, { message: 'boom' }) });
    const r = await newClient().getReservation(id);
    expect(r.money.balanceDue).toBeUndefined();
    expect(r.checkIn).toBe(legacy.checkIn);
    expect(r.listingId).toBe(legacy.listingId);
    expect(r.guest.fullName).toBe(legacy.guest.fullName);
  });

  it('d) guests-crud 404 → kein Wurf, ohne guest, Kernfelder da', async () => {
    route({ ...fixtureRoutes(kind), guest: () => jsonResponse(404, { message: 'nope' }) });
    const r = await newClient().getReservation(id);
    expect(r.guest).toBeUndefined();
    expect(r.checkIn).toBe(legacy.checkIn);
    expect(r.money.balanceDue).toBe(legacy.money.balanceDue);
  });
});

describe('getReservation Fehlerfall', () => {
  it('c) by-ids liefert [] → ExternalApiError 404', async () => {
    route({ byIds: () => jsonResponse(200, []) });
    const err = await newClient().getReservation('f968c4967e199e2cb25c43fa').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect((err as ExternalApiError).statusCode).toBe(404);
  });
});

describe('getReservationsV3ByIds', () => {
  it('e) 23 IDs → 3 Aufrufe à 10/10/3; Duplikate nur einmal', async () => {
    route({ byIds: () => jsonResponse(200, []) });
    const ids = Array.from({ length: 23 }, (_, i) => i.toString(16).padStart(24, '0'));
    await newClient().getReservationsV3ByIds([...ids, ids[0], ids[5]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const counts = urls().map((u) => (u.match(/reservationIds\[\]=/g) ?? []).length).sort((a, b) => b - a);
    expect(counts).toEqual([10, 10, 3]);
    const all = urls().flatMap((u) => [...u.matchAll(/reservationIds\[\]=([0-9a-f]+)/g)].map((m) => m[1]));
    expect(new Set(all).size).toBe(23);
    expect(all.length).toBe(23);
  });
});

describe('getReservationsPage', () => {
  const searchFx = load('v3-search-manual.json');
  const legacy = load('legacy-get-manual.json');
  const LID = '686d1e927ae7af00234115ad';

  it('f) Filter in der URL, Ergebnis adaptiert, hasMore aus pagination', async () => {
    route({ search: () => jsonResponse(200, searchFx) });
    const page = await newClient().getReservationsPage({ listingId: LID, limit: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = new URL('http://x' + new URL(urls()[0]).pathname.replace('/v1', '') + new URL(urls()[0]).search);
    expect(urls()[0]).toContain('/reservations-v3/search?');
    expect(u.searchParams.get('filter[listingId]')).toBe(LID);
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.get('filter[status]')!.split(',')).toEqual([...ALL_RESERVATION_STATUSES]);
    expect(page.results[0]._id).toBe(searchFx.results[0].reservationId);
    expect(page.results[0].listingId).toBe(LID);
    expect(page.results[0].checkIn).toBe(legacy.checkIn);
    expect(page.hasMore).toBe(searchFx.pagination.hasMore);
  });

  it('g) fremdes stay[0].listingId wird herausgefiltert, hasMore folgt pagination', async () => {
    route({ search: () => jsonResponse(200, searchFx) });
    const page = await newClient().getReservationsPage({ listingId: 'X', limit: 100 });
    expect(page.results).toEqual([]);
    expect(page.hasMore).toBe(searchFx.pagination.hasMore);
  });

  it('h) ohne pagination: hasMore = Rohanzahl >= limit', async () => {
    const two = { results: [searchFx.results[0], searchFx.results[0]] };
    route({ search: () => jsonResponse(200, two) });
    const client = newClient();
    expect((await client.getReservationsPage({ limit: 2 })).hasMore).toBe(true);
    expect((await client.getReservationsPage({ limit: 3 })).hasMore).toBe(false);
  });
});
