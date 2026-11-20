import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: {
      ...mod.config,
      agentApiKey: 'test-agent-key-0123456789abcdef0123456789',
      agentApiKeySet: ['test-agent-key-0123456789abcdef0123456789'],
    },
  };
});

const getCalendarMock = vi.fn();
const setPricingMock = vi.fn();
const getFinancialsMock = vi.fn();
const setBasePriceMock = vi.fn();
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getCalendar: (...a: unknown[]) => getCalendarMock(...a),
    setListingCalendarPricing: (...a: unknown[]) => setPricingMock(...a),
    getListingFinancials: (...a: unknown[]) => getFinancialsMock(...a),
    updateListingBasePrice: (...a: unknown[]) => setBasePriceMock(...a),
  },
}));
const syncListingMock = vi.fn();
vi.mock('../jobs/sync-listing.js', () => ({
  syncListing: (...a: unknown[]) => syncListingMock(...a),
}));

const getPropertiesMock = vi.fn();
const getListingCalendarsMock = vi.fn();
const getReservationsMock = vi.fn();
const updatePricesMock = vi.fn();
const updateRestrictionsMock = vi.fn();
vi.mock('../services/hostex-client.js', () => ({
  getHostexClient: () => ({
    getProperties: (...a: unknown[]) => getPropertiesMock(...a),
    getListingCalendars: (...a: unknown[]) => getListingCalendarsMock(...a),
    getReservations: (...a: unknown[]) => getReservationsMock(...a),
    updateListingPrices: (...a: unknown[]) => updatePricesMock(...a),
    updateListingRestrictions: (...a: unknown[]) => updateRestrictionsMock(...a),
  }),
}));

const triggerRefreshMock = vi.fn();
vi.mock('../services/property-calendar-refresh.js', () => ({
  triggerPropertyCalendarRefresh: (...a: unknown[]) => triggerRefreshMock(...a),
}));
vi.mock('../services/auto-send/berlin-day.js', () => ({
  berlinCalendarDay: () => '2026-11-20',
}));
const loggerInfoMock = vi.fn();
vi.mock('../utils/logger.js', () => ({
  default: { info: (...a: unknown[]) => loggerInfoMock(...a), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import agentPricingRouter, { pricingVerifyDelays } from './agent-pricing.js';
import { GUESTY_MAX_RUNS_PER_CALL } from '../services/pricing-service.js';
import { ExternalApiError } from '../utils/errors.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentPricingRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };
const FARMHOUSE_ID = '686d1e927ae7af00234115ad';
const CH_ID = '1406340600305404294';

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function gDay(date: string, price: number, minNights: number, extra: Record<string, unknown> = {}) {
  return { date, listingId: 'L', currency: 'EUR', price, minNights, status: 'available', allotment: 1, blocks: {}, blockRefs: [], ...extra };
}
function gOccupied(date: string, price = 139, minNights = 1) {
  return gDay(date, price, minNights, {
    status: 'unavailable', allotment: 0,
    blockRefs: [{ _id: 'b1', listingId: 'L', startDate: date, endDate: date, type: 'b', reservationId: 'R1',
      reservation: { _id: 'R1', listingId: 'L', status: 'confirmed' } }],
  });
}
function gRange(from: string, to: string, price: number, minNights: number) {
  return dates(from, to).map((d) => gDay(d, price, minNights));
}
function hDay(date: string, price: number, min = 1, restr: Record<string, unknown> = {}) {
  return { date, price, inventory: 1, restrictions: { min_stay_on_arrival: min, max_stay_on_arrival: 30, closed_on_arrival: false, closed_on_departure: false, ...restr } };
}
function hostexCal(days: unknown[]) {
  return { listings: [{ listing_id: CH_ID, channel_type: 'airbnb', calendar: days }] };
}
async function req(method: 'GET' | 'PUT', path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/agent${path}`, {
    method, headers: { ...KEY, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as any };
}

beforeEach(() => {
  pricingVerifyDelays.hostex = [0];
  pricingVerifyDelays.guesty = [0];
  for (const m of [getCalendarMock, setPricingMock, getPropertiesMock, getListingCalendarsMock, getReservationsMock,
    updatePricesMock, updateRestrictionsMock, triggerRefreshMock, loggerInfoMock,
    getFinancialsMock, setBasePriceMock, syncListingMock]) m.mockReset();
  setBasePriceMock.mockResolvedValue({ basePrice: 1600 });
  syncListingMock.mockResolvedValue({ success: true, listingId: FARMHOUSE_ID });
  setPricingMock.mockResolvedValue(undefined);
  triggerRefreshMock.mockReturnValue('angestoßen');
  getPropertiesMock.mockResolvedValue([
    { id: 12659677, title: 'Bootshaus', channels: [{ channel_type: 'airbnb', listing_id: CH_ID, currency: 'EUR' }] },
    { id: 12659676, title: 'Schilderwerkstatt', channels: [{ channel_type: 'airbnb', listing_id: '999', currency: 'EUR' }] },
  ]);
  getReservationsMock.mockResolvedValue([]);
  updatePricesMock.mockResolvedValue(undefined);
  updateRestrictionsMock.mockResolvedValue(undefined);
});

describe('GET /pricing/:slug', () => {
  it('u19: liefert Tage mit Preis, Mindestnächten, Belegung und Anreise-/Abreisesperre', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-03', 139, 1));
    const r = await req('GET', '/pricing/u19?from=2027-05-01&to=2027-05-03');
    expect(r.status).toBe(200);
    expect(r.body.property.provider).toBe('guesty');
    expect(r.body.days).toHaveLength(3);
    expect(r.body.days[0]).toEqual({ date: '2027-05-01', price: 139, minNights: 1, occupied: false, closedOnArrival: false, closedOnDeparture: false });
  });

  it('farmhouse: gleiche Form, getCalendar mit Farmhouse-Listing-ID', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-03', 200, 2));
    const r = await req('GET', '/pricing/farmhouse?from=2027-05-01&to=2027-05-03');
    expect(r.status).toBe(200);
    expect(r.body.property.provider).toBe('guesty');
    expect(getCalendarMock).toHaveBeenCalledWith(FARMHOUSE_ID, '2027-05-01', '2027-05-03');
    expect(r.body.days.map((d: any) => [d.date, d.price, d.minNights])).toEqual([
      ['2027-05-01', 200, 2], ['2027-05-02', 200, 2], ['2027-05-03', 200, 2]]);
  });

  it('farmhouse 24.12.2026 bis 01.01.2027: zeigt die heutigen Preise je Tag', async () => {
    const days = dates('2026-12-24', '2027-01-01').map((d, i) => gDay(d, 300 + i, 3));
    getCalendarMock.mockResolvedValue(days);
    const r = await req('GET', '/pricing/farmhouse?from=2026-12-24&to=2027-01-01');
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(9);
    expect(r.body.days.map((d: any) => d.price)).toEqual([300, 301, 302, 303, 304, 305, 306, 307, 308]);
  });

  it('bootshaus-alte-oder: Kanal-Listing, Belegung 02. und 03. aber nicht 04.', async () => {
    getListingCalendarsMock.mockResolvedValue(hostexCal(dates('2027-05-01', '2027-05-05').map((d) => hDay(d, 129, 2))));
    getReservationsMock.mockResolvedValue([
      { reservation_code: 'HX1', status: 'accepted', check_in_date: '2027-05-02', check_out_date: '2027-05-04' },
    ]);
    const r = await req('GET', '/pricing/bootshaus-alte-oder?from=2027-05-01&to=2027-05-05');
    expect(r.status).toBe(200);
    expect(r.body.property.provider).toBe('hostex');
    expect(getListingCalendarsMock).toHaveBeenCalledWith(expect.objectContaining({
      listings: [{ channel_type: 'airbnb', listing_id: CH_ID }],
    }));
    const occ = Object.fromEntries(r.body.days.map((d: any) => [d.date, d.occupied]));
    expect(occ).toEqual({ '2027-05-01': false, '2027-05-02': true, '2027-05-03': true, '2027-05-04': false, '2027-05-05': false });
    expect(r.body.days[0]).toMatchObject({ price: 129, minNights: 2, closedOnArrival: false, closedOnDeparture: false });
  });

  it('unbekannter Slug 404, firenze-loft 400', async () => {
    expect((await req('GET', '/pricing/gibt-es-nicht')).status).toBe(404);
    expect((await req('GET', '/pricing/firenze-loft')).status).toBe(400);
  });
});

describe('PUT /pricing/:slug Validierung', () => {
  it('unbekannter Slug 404, firenze-loft 400', async () => {
    const body = { from: '2027-05-01', to: '2027-05-02', price: 100 };
    expect((await req('PUT', '/pricing/gibt-es-nicht', body)).status).toBe(404);
    expect((await req('PUT', '/pricing/firenze-loft', body)).status).toBe(400);
  });

  it('lehnt ungültige Bodys mit 400 ab, ohne zu schreiben', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-03', 139, 1));
    const bad: Array<[string, string, unknown]> = [
      ['from nach to', 'u19', { from: '2027-05-05', to: '2027-05-01', price: 100 }],
      ['731 Tage', 'u19', { from: '2027-05-01', to: '2029-05-01', price: 100 }],
      ['price 0', 'u19', { from: '2027-05-01', to: '2027-05-02', price: 0 }],
      ['minNights 0', 'u19', { from: '2027-05-01', to: '2027-05-02', minNights: 0 }],
      ['price und factor', 'u19', { from: '2027-05-01', to: '2027-05-02', price: 100, factor: 1.1 }],
      ['Hostex price 129.5', 'bootshaus-alte-oder', { from: '2027-05-01', to: '2027-05-02', price: 129.5 }],
    ];
    for (const [label, slug, body] of bad) {
      const r = await req('PUT', `/pricing/${slug}`, body);
      expect(r.status, label).toBe(400);
    }
    expect(setPricingMock).not.toHaveBeenCalled();
    expect(updatePricesMock).not.toHaveBeenCalled();
    expect(updateRestrictionsMock).not.toHaveBeenCalled();
  });
});

describe('PUT /pricing/:slug Guesty', () => {
  it('dryRun: 153 Änderungen 139 auf 160, kein Schreiben, kein Refresh, ein Lauf', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-09-30', 139, 1));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-09-30', price: 160, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.changes).toHaveLength(153);
    for (const c of r.body.changes) expect(c.price).toEqual({ old: 139, new: 160 });
    expect(setPricingMock).not.toHaveBeenCalled();
    expect(triggerRefreshMock).not.toHaveBeenCalled();
    expect(r.body.runs).toEqual([{ from: '2027-05-01', to: '2027-09-30', nights: 153, price: 160 }]);
  });

  it('farmhouse dryRun factor 1: keine Änderungen, 9 Tage unverändert', async () => {
    getCalendarMock.mockResolvedValue(gRange('2026-12-24', '2027-01-01', 300, 3));
    const r = await req('PUT', '/pricing/farmhouse', { from: '2026-12-24', to: '2027-01-01', factor: 1, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual([]);
    expect(r.body.unchanged).toHaveLength(9);
  });

  it('weekdays [5,6] mit minNights 2: ein Guesty-PUT je Wochenendlauf, ohne price', async () => {
    getCalendarMock
      .mockResolvedValueOnce(gRange('2027-05-01', '2027-05-16', 139, 1))
      .mockResolvedValueOnce(gRange('2027-05-01', '2027-05-16', 139, 2));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-16', weekdays: [5, 6], minNights: 2 });
    expect(r.status).toBe(200);
    expect(setPricingMock).toHaveBeenCalledTimes(3);
    const calls = setPricingMock.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([
      { startDate: '2027-05-01', endDate: '2027-05-01', minNights: 2 },
      { startDate: '2027-05-07', endDate: '2027-05-08', minNights: 2 },
      { startDate: '2027-05-14', endDate: '2027-05-15', minNights: 2 },
    ]);
    for (const c of calls) expect(c).not.toHaveProperty('price');
    expect(r.body.applied).toBe(true);
    expect(r.body.written.map((w: any) => [w.from, w.to])).toEqual([
      ['2027-05-01', '2027-05-01'], ['2027-05-07', '2027-05-08'], ['2027-05-14', '2027-05-15']]);
    expect(triggerRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('factor 1.15 auf 139 ergibt 160 (Rundung)', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-01', 139, 1));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-01', factor: 1.15, dryRun: true });
    expect(r.body.changes).toEqual([{ date: '2027-05-01', price: { old: 139, new: 160 } }]);
  });

  it('alter Preis 159.85 mit factor 1 ergibt 160 und gilt als Änderung', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-01', 159.85, 1));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-01', factor: 1, dryRun: true });
    expect(r.body.changes).toEqual([{ date: '2027-05-01', price: { old: 159.85, new: 160 } }]);
    expect(r.body.unchanged).toEqual([]);
  });

  it('belegter Tag wird übersprungen, Läufe um ihn herum geteilt', async () => {
    const before = gRange('2027-05-01', '2027-05-05', 139, 1);
    before[2] = gOccupied('2027-05-03');
    const after = gRange('2027-05-01', '2027-05-05', 160, 1);
    after[2] = gOccupied('2027-05-03');
    getCalendarMock.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-05', price: 160 });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toHaveLength(1);
    expect(r.body.skipped[0].date).toBe('2027-05-03');
    expect(r.body.skipped[0].reason).toMatch(/Reservierung/);
    expect(setPricingMock.mock.calls.map((c) => c[1])).toEqual([
      { startDate: '2027-05-01', endDate: '2027-05-02', price: 160 },
      { startDate: '2027-05-04', endDate: '2027-05-05', price: 160 },
    ]);
  });

  it('Teilfehler beim zweiten Lauf: 502, applied false, nur erster Lauf in written, Refresh trotzdem', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-09', 139, 1));
    setPricingMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ExternalApiError('Guesty kaputt', 502, 'guesty'));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-09', weekdays: [6], price: 160 });
    expect(r.status).toBe(502);
    expect(r.body.applied).toBe(false);
    expect(r.body.written).toEqual([{ from: '2027-05-01', to: '2027-05-01', nights: 1, price: 160 }]);
    expect(triggerRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('notApplied: Nachlesen zeigt noch den alten Wert', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-02', 139, 1));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-02', price: 160 });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.notApplied).toEqual(['2027-05-01', '2027-05-02']);
  });

  it('nichts zu ändern ohne dryRun: kein Schreibaufruf, calendarSync "nicht nötig"', async () => {
    getCalendarMock.mockResolvedValue(gRange('2027-05-01', '2027-05-03', 160, 1));
    const r = await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-03', price: 160 });
    expect(r.status).toBe(200);
    expect(setPricingMock).not.toHaveBeenCalled();
    expect(r.body.calendarSync).toBe('nicht nötig');
    expect(triggerRefreshMock).not.toHaveBeenCalled();
  });

  it('loggt Änderung mit slug, Zeitraum, Preis alt/neu und caller mit Key-Nummer', async () => {
    getCalendarMock
      .mockResolvedValueOnce(gRange('2027-05-01', '2027-05-02', 139, 1))
      .mockResolvedValueOnce(gRange('2027-05-01', '2027-05-02', 160, 1));
    await req('PUT', '/pricing/u19', { from: '2027-05-01', to: '2027-05-02', price: 160, caller: 'hauptsession' });
    const call = loggerInfoMock.mock.calls.find((c) => c[1] === 'Agent pricing change');
    expect(call).toBeTruthy();
    expect(call![0]).toMatchObject({ slug: 'u19', from: '2027-05-01', to: '2027-05-02', price: { old: [139], new: 160 } });
    expect(call![0].caller).toContain('hauptsession');
    expect(call![0].caller).toContain('(key #1)');
  });
});

describe('PUT /pricing/:slug Hostex', () => {
  it('bootshaus price 160 + minNights 3: Preislauf, Restriktionen je Lauf mit Ist-Stand der Sperren', async () => {
    // 2027-05-02 ist ein Sonntag
    const before = [hDay('2027-05-02', 129, 1, { closed_on_arrival: true }), hDay('2027-05-03', 129, 1)];
    const after = [hDay('2027-05-02', 160, 3, { closed_on_arrival: true }), hDay('2027-05-03', 160, 3)];
    getListingCalendarsMock.mockResolvedValueOnce(hostexCal(before)).mockResolvedValueOnce(hostexCal(after));
    const r = await req('PUT', '/pricing/bootshaus-alte-oder', { from: '2027-05-02', to: '2027-05-03', price: 160, minNights: 3 });
    expect(r.status).toBe(200);
    expect(updatePricesMock).toHaveBeenCalledTimes(1);
    expect(updatePricesMock).toHaveBeenCalledWith({
      channelType: 'airbnb', listingId: CH_ID, prices: [{ startDate: '2027-05-02', endDate: '2027-05-03', price: 160 }],
    });
    expect(updateRestrictionsMock).toHaveBeenCalledTimes(1);
    expect(updateRestrictionsMock).toHaveBeenCalledWith({
      channelType: 'airbnb', listingId: CH_ID,
      restrictions: [
        { startDate: '2027-05-02', endDate: '2027-05-02', minStayOnArrival: 3, closedOnArrival: true, closedOnDeparture: false },
        { startDate: '2027-05-03', endDate: '2027-05-03', minStayOnArrival: 3, closedOnArrival: false, closedOnDeparture: false },
      ],
    });
    expect(r.body.applied).toBe(true);
    expect(r.body.notApplied).toBeUndefined();
  });

  it('dryRun: belegter Tag in skipped, kein Schreibaufruf, kein Refresh, kein Änderungslog (Prüfer)', async () => {
    getListingCalendarsMock.mockResolvedValue(hostexCal(dates('2027-05-03', '2027-05-06').map((d) => hDay(d, 129, 2))));
    getReservationsMock.mockResolvedValue([
      { reservation_code: 'HX1', status: 'accepted', check_in_date: '2027-05-04', check_out_date: '2027-05-05' },
    ]);
    const r = await req('PUT', '/pricing/bootshaus-alte-oder', { from: '2027-05-03', to: '2027-05-06', factor: 1.1, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.changes.map((c: any) => [c.date, c.price])).toEqual([
      ['2027-05-03', { old: 129, new: 142 }], ['2027-05-05', { old: 129, new: 142 }], ['2027-05-06', { old: 129, new: 142 }]]);
    expect(r.body.skipped).toEqual([{ date: '2027-05-04', reason: expect.stringMatching(/Reservierung HX1/) }]);
    expect(r.body.runs).toEqual([
      { from: '2027-05-03', to: '2027-05-03', nights: 1, price: 142 },
      { from: '2027-05-05', to: '2027-05-06', nights: 2, price: 142 },
    ]);
    expect(updatePricesMock).not.toHaveBeenCalled();
    expect(updateRestrictionsMock).not.toHaveBeenCalled();
    expect(triggerRefreshMock).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls.some((c) => c[1] === 'Agent pricing change')).toBe(false);
  });

  it('Vollzug: belegter Tag wird nicht geschrieben, Refresh erst nach dem Nachlesen (Prüfer)', async () => {
    const order: string[] = [];
    const before = dates('2027-05-03', '2027-05-05').map((d) => hDay(d, 129, 2));
    const after = [hDay('2027-05-03', 140, 2), hDay('2027-05-04', 129, 2), hDay('2027-05-05', 140, 2)];
    getListingCalendarsMock
      .mockImplementationOnce(async () => { order.push('read'); return hostexCal(before); })
      .mockImplementationOnce(async () => { order.push('read'); return hostexCal(after); });
    getReservationsMock.mockResolvedValue([
      { reservation_code: 'HX1', status: 'wait_accept', check_in_date: '2027-05-04', check_out_date: '2027-05-05' },
    ]);
    updatePricesMock.mockImplementation(async () => { order.push('write'); });
    triggerRefreshMock.mockImplementation(() => { order.push('refresh'); return 'angestoßen'; });
    const r = await req('PUT', '/pricing/bootshaus-alte-oder', { from: '2027-05-03', to: '2027-05-05', price: 140 });
    expect(r.status).toBe(200);
    expect(updatePricesMock).toHaveBeenCalledWith({
      channelType: 'airbnb', listingId: CH_ID,
      prices: [
        { startDate: '2027-05-03', endDate: '2027-05-03', price: 140 },
        { startDate: '2027-05-05', endDate: '2027-05-05', price: 140 },
      ],
    });
    expect(updateRestrictionsMock).not.toHaveBeenCalled();
    expect(r.body.skipped.map((s: any) => s.date)).toEqual(['2027-05-04']);
    expect(r.body.notApplied).toBeUndefined();
    expect(r.body.calendarSync).toBe('angestoßen');
    expect(order).toEqual(['read', 'write', 'read', 'refresh']);
  });
});

/** n einzelne, nicht zusammenhängende Läufe (jeder zweite Tag) ab 2027-05-01. */
function alternatingDays(n: number) {
  const ds = dates('2027-05-01', '2027-12-31').slice(0, 2 * n - 1);
  return { from: ds[0], to: ds[ds.length - 1], days: ds.map((d, i) => gDay(d, i % 2 === 0 ? 139 : 160, 1)) };
}

describe('PUT /pricing/:slug Obergrenze Läufe bei Guesty (#1304/#1305)', () => {
  it('Grenze 40 an einer Stelle', () => {
    expect(GUESTY_MAX_RUNS_PER_CALL).toBe(40);
  });

  it('41 Läufe ohne dryRun: 400 mit runs/maxRuns/Hinweis, kein Schreiben, kein Refresh, kein Änderungslog', async () => {
    const { from, to, days } = alternatingDays(41);
    getCalendarMock.mockResolvedValue(days);
    const r = await req('PUT', '/pricing/u19', { from, to, price: 160 });
    expect(r.status).toBe(400);
    expect(r.body.runs).toBe(41);
    expect(r.body.maxRuns).toBe(40);
    expect(r.body.error).toMatch(/Zeitraum.*teilen/);
    expect(setPricingMock).not.toHaveBeenCalled();
    expect(triggerRefreshMock).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls.filter((c) => c[1] === 'Agent pricing change')).toHaveLength(0);
  });

  it('genau 40 Läufe: wird geschrieben (40 PUTs)', async () => {
    const { from, to, days } = alternatingDays(40);
    const after = days.map((d) => ({ ...d, price: 160 }));
    getCalendarMock.mockResolvedValueOnce(days).mockResolvedValueOnce(after);
    const r = await req('PUT', '/pricing/u19', { from, to, price: 160 });
    expect(r.status).toBe(200);
    expect(setPricingMock).toHaveBeenCalledTimes(40);
    expect(r.body.applied).toBe(true);
    expect(triggerRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('dryRun mit 41 Läufen: 200, Plan wie bisher, maxRuns 40, exceedsMaxRuns true', async () => {
    const { from, to, days } = alternatingDays(41);
    getCalendarMock.mockResolvedValue(days);
    const r = await req('PUT', '/pricing/u19', { from, to, price: 160, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.runs).toHaveLength(41);
    expect(r.body.maxRuns).toBe(40);
    expect(r.body.exceedsMaxRuns).toBe(true);
    expect(setPricingMock).not.toHaveBeenCalled();
  });

  it('dryRun mit 40 Läufen: exceedsMaxRuns false', async () => {
    const { from, to, days } = alternatingDays(40);
    getCalendarMock.mockResolvedValue(days);
    const r = await req('PUT', '/pricing/u19', { from, to, price: 160, dryRun: true });
    expect(r.body.maxRuns).toBe(40);
    expect(r.body.exceedsMaxRuns).toBe(false);
  });

  it('Hostex unverändert: 60 Läufe werden geschrieben (ein Stapel), dryRun ohne Grenze', async () => {
    const ds = dates('2027-05-01', '2027-12-31').slice(0, 119);
    const before = ds.map((d, i) => hDay(d, i % 2 === 0 ? 129 : 140, 2));
    const after = ds.map((d) => hDay(d, 140, 2));
    getListingCalendarsMock.mockResolvedValueOnce(hostexCal(before)).mockResolvedValueOnce(hostexCal(before))
      .mockResolvedValueOnce(hostexCal(after));
    const dry = await req('PUT', '/pricing/bootshaus-alte-oder', { from: ds[0], to: ds[118], price: 140, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.runs).toHaveLength(60);
    expect(dry.body.maxRuns).toBeNull();
    expect(dry.body.exceedsMaxRuns).toBe(false);
    const r = await req('PUT', '/pricing/bootshaus-alte-oder', { from: ds[0], to: ds[118], price: 140 });
    expect(r.status).toBe(200);
    expect(updatePricesMock).toHaveBeenCalledTimes(1);
    expect(updatePricesMock.mock.calls[0][0].prices).toHaveLength(60);
    expect(r.body.written).toHaveLength(60);
  });
});

describe('PUT /pricing/:slug basePrice (#1305)', () => {
  it('farmhouse dryRun: liest alt frisch von Guesty, zeigt alt 1500 und neu 1600, schreibt nichts', async () => {
    getFinancialsMock.mockResolvedValue({ basePrice: 1500, weekendBasePrice: null, currency: 'EUR' });
    const r = await req('PUT', '/pricing/farmhouse', { basePrice: 1600, dryRun: true });
    expect(r.status).toBe(200);
    expect(getFinancialsMock).toHaveBeenCalledWith(FARMHOUSE_ID);
    expect(r.body.basePrice).toEqual({ old: 1500, new: 1600 });
    expect(r.body.unchanged).toBe(false);
    expect(r.body.dryRun).toBe(true);
    expect(setBasePriceMock).not.toHaveBeenCalled();
    expect(syncListingMock).not.toHaveBeenCalled();
    expect(triggerRefreshMock).not.toHaveBeenCalled();
    expect(getCalendarMock).not.toHaveBeenCalled();
    expect(setPricingMock).not.toHaveBeenCalled();
  });

  it('Vollzug: PUT Financials, Nachlesen, Änderungslog mit alt/neu/Aufrufer, Listing-Cache und Kalender auffrischen', async () => {
    const order: string[] = [];
    getFinancialsMock
      .mockImplementationOnce(async () => { order.push('read'); return { basePrice: 1500 }; })
      .mockImplementationOnce(async () => { order.push('read'); return { basePrice: 1600 }; });
    setBasePriceMock.mockImplementation(async () => { order.push('write'); return { basePrice: 1600 }; });
    syncListingMock.mockImplementation(async () => { order.push('listing-sync'); return { success: true }; });
    triggerRefreshMock.mockImplementation(() => { order.push('refresh'); return 'angestoßen'; });
    const r = await req('PUT', '/pricing/farmhouse', { basePrice: 1600, caller: 'preise-2027' });
    expect(r.status).toBe(200);
    expect(setBasePriceMock).toHaveBeenCalledWith(FARMHOUSE_ID, 1600);
    expect(r.body).toMatchObject({ applied: true, written: true, basePrice: { old: 1500, new: 1600 }, current: 1600, listingCacheRefreshed: true, calendarSync: 'angestoßen' });
    expect(r.body.notApplied).toBeUndefined();
    expect(order).toEqual(['read', 'write', 'read', 'listing-sync', 'refresh']);
    expect(syncListingMock).toHaveBeenCalledWith(FARMHOUSE_ID, true);
    const log = loggerInfoMock.mock.calls.find((c) => c[1] === 'Agent pricing base price change');
    expect(log?.[0]).toMatchObject({ slug: 'farmhouse', basePrice: { old: 1500, new: 1600 } });
    expect(log?.[0].caller).toMatch(/^preise-2027 \(key #1\)$/);
    expect(getCalendarMock).not.toHaveBeenCalled();
    expect(setPricingMock).not.toHaveBeenCalled();
  });

  it('schon gesetzt: kein Schreiben, aber Listing-Cache auffrischen (veralteter Cache)', async () => {
    getFinancialsMock.mockResolvedValue({ basePrice: 1600 });
    const r = await req('PUT', '/pricing/farmhouse', { basePrice: 1600 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, written: false, unchanged: true, listingCacheRefreshed: true, calendarSync: 'nicht nötig' });
    expect(setBasePriceMock).not.toHaveBeenCalled();
    expect(syncListingMock).toHaveBeenCalledWith(FARMHOUSE_ID, true);
    expect(triggerRefreshMock).not.toHaveBeenCalled();
  });

  it('Nachlesen zeigt alten Wert: notApplied, Nachlesefehler: verifyFailed (beides 200, geschrieben)', async () => {
    getFinancialsMock.mockResolvedValueOnce({ basePrice: 1500 }).mockResolvedValueOnce({ basePrice: 1500 });
    const a = await req('PUT', '/pricing/farmhouse', { basePrice: 1600 });
    expect(a.status).toBe(200);
    expect(a.body.notApplied).toBe(true);
    expect(a.body.current).toBe(1500);
    getFinancialsMock.mockReset().mockResolvedValueOnce({ basePrice: 1500 }).mockRejectedValueOnce(new Error('timeout'));
    const b = await req('PUT', '/pricing/farmhouse', { basePrice: 1600 });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ written: true, verifyFailed: true, verifyError: 'timeout' });
  });

  it('Schreibfehler bei Guesty: Fehlerstatus, kein Änderungslog, kein Refresh', async () => {
    getFinancialsMock.mockResolvedValue({ basePrice: 1500 });
    setBasePriceMock.mockRejectedValue(new ExternalApiError('Guesty 403', 502, 'guesty'));
    const r = await req('PUT', '/pricing/farmhouse', { basePrice: 1600 });
    expect(r.status).toBe(502);
    expect(loggerInfoMock.mock.calls.filter((c) => c[1] === 'Agent pricing base price change')).toHaveLength(0);
    expect(syncListingMock).not.toHaveBeenCalled();
    expect(triggerRefreshMock).not.toHaveBeenCalled();
  });

  it('Hostex-Objekt: 400 ohne Anbieteraufruf', async () => {
    const r = await req('PUT', '/pricing/bootshaus-alte-oder', { basePrice: 150, dryRun: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nur für provider=guesty/);
    expect(getPropertiesMock).not.toHaveBeenCalled();
    expect(getFinancialsMock).not.toHaveBeenCalled();
  });

  it('airbnb-mail: 400; unbekannter Slug: 404', async () => {
    expect((await req('PUT', '/pricing/firenze-loft', { basePrice: 150 })).status).toBe(400);
    expect((await req('PUT', '/pricing/gibtsnicht', { basePrice: 150 })).status).toBe(404);
  });

  it.each([
    [{ basePrice: 0 }], [{ basePrice: 10001 }], [{ basePrice: 1600.123 }], [{ basePrice: '1600' }],
    [{ basePrice: 1600, from: '2027-01-01', to: '2027-01-31' }], [{ basePrice: 1600, price: 1600 }],
  ])('Validierung %j → 400 ohne Guesty-Aufruf', async (body) => {
    const r = await req('PUT', '/pricing/farmhouse', body);
    expect(r.status).toBe(400);
    expect(getFinancialsMock).not.toHaveBeenCalled();
    expect(setBasePriceMock).not.toHaveBeenCalled();
  });

  it('Guesty liefert keinen basePrice: alt null, Schreiben möglich', async () => {
    getFinancialsMock.mockResolvedValue({});
    const r = await req('PUT', '/pricing/farmhouse', { basePrice: 1600, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.basePrice).toEqual({ old: null, new: 1600 });
  });
});
