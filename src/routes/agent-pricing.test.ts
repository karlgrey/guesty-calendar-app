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
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getCalendar: (...a: unknown[]) => getCalendarMock(...a),
    setListingCalendarPricing: (...a: unknown[]) => setPricingMock(...a),
  },
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
    updatePricesMock, updateRestrictionsMock, triggerRefreshMock, loggerInfoMock]) m.mockReset();
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
});
