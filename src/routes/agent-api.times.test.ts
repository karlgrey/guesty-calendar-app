// #799: Ende-zu-Ende über die Route: echter Service + In-Memory-DB + echte properties.json,
// gemockt sind nur Guesty-Client (getCalendar/Listing-Kalender-PUT), updateReservation (darf nie aufgerufen werden) und der Google-Kalender-Sync.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, agentApiKey: 'k'.repeat(40), agentApiKeySet: ['k'.repeat(40)] } };
});
const setCalMock = vi.fn();
const getCalMock = vi.fn();
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getReservation: vi.fn().mockResolvedValue({ _id: 'x', status: 'confirmed' }), setListingCalendarStatus: (...a: unknown[]) => setCalMock(...a), getCalendar: (...a: unknown[]) => getCalMock(...a) },
}));
const updateReservationMock = vi.fn();
vi.mock('../services/reservation-update-service.js', async (orig) => ({
  ...(await orig<typeof import('../services/reservation-update-service.js')>()),
  updateReservation: (...a: unknown[]) => updateReservationMock(...a),
}));
const syncMock = vi.fn();
vi.mock('../jobs/sync-google-calendar.js', () => ({ syncGoogleCalendarForProperty: (...a: unknown[]) => syncMock(...a) }));

import agentApiRoutes from './agent-api.js';
import { resetCalendarSyncGuard } from '../services/stay-times-service.js';
import { getOverride } from '../repositories/stay-time-override-repository.js';
import { ExternalApiError } from '../utils/errors.js';

const FARMHOUSE_LISTING = '686d1e927ae7af00234115ad';
let server: Server; let base: string; let db: Database.Database;
const KEY = { 'X-Agent-Key': 'k'.repeat(40), 'Content-Type': 'application/json' };
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const future = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function insertRes(id: string, listing: string, over: Record<string, unknown> = {}) {
  const r = {
    reservation_id: id, listing_id: listing, check_in: future(5), check_out: future(7),
    check_in_localized: future(5), check_out_localized: future(7), nights_count: 2,
    status: 'confirmed', source: 'manual', platform: 'direct', ...over,
  };
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, source, platform, last_synced_at)
    VALUES (@reservation_id, @listing_id, @check_in, @check_out, @check_in_localized, @check_out_localized, @nights_count, @status, @source, @platform, 'x')`).run(r);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCalendarSyncGuard();
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, check_in_time TEXT, check_out_time TEXT, taxes TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO listings (id, check_in_time, check_out_time) VALUES ('${FARMHOUSE_LISTING}','08:00:00','12:00:00'), ('12659677','15:00:00','12:00:00');`);
  for (const m of ['002_add_reservations_table.sql', '012_add_guest_fingerprint.sql', '035_add_stay_time_overrides.sql', '036_add_stay_time_override_block_state.sql', '037_add_stay_time_override_block_date.sql']) {
    db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
  }
  setDatabase(db);
  syncMock.mockResolvedValue({ success: true, eventsUpserted: 1, eventsDeleted: 0 });
  updateReservationMock.mockResolvedValue({});
  setCalMock.mockResolvedValue({});
  getCalMock.mockResolvedValue([{ date: future(8), status: 'available' }]);
});
afterEach(() => { resetDatabase(); db.close(); });

const put = (id: string, body: unknown) => fetch(`${base}/api/agent/reservations/${id}/times`, { method: 'PUT', headers: KEY, body: JSON.stringify(body) });

describe('PUT/GET/DELETE /reservations/:id/times — Ende zu Ende (#799)', () => {
  it('Farmhouse-Direktbuchung: Override + Block über Listing-Kalender (nie updateReservation), Sync fire-and-forget', async () => {
    insertRes('fh-direkt', FARMHOUSE_LISTING);
    const r = await put('fh-direkt', { plannedDeparture: '18:00', blockNextDay: true, note: 'Chat' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true, reservationId: 'fh-direkt', calendarSync: 'angestoßen',
      nextDayBlock: { applied: true, method: 'listing-calendar', blockState: 'set-by-us', blockDate: future(8) },
      times: { effectiveDeparture: '18:00', departureSource: 'override', override: { blockNextDay: true, blockState: 'set-by-us', blockDate: future(8), source: 'agent' } },
    });
    expect(body).not.toHaveProperty('calendarSynced');
    expect(setCalMock).toHaveBeenCalledWith(FARMHOUSE_LISTING, {
      startDate: future(8), endDate: future(8), status: 'unavailable', note: 'Late-Checkout fh-direkt',
    });
    expect(updateReservationMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
  });

  it('PUT antwortet, obwohl der Kalender-Sync nie fertig wird', async () => {
    insertRes('fh-direkt', FARMHOUSE_LISTING);
    syncMock.mockReturnValue(new Promise(() => {}));
    const r = await put('fh-direkt', { plannedDeparture: '18:00' });
    expect(r.status).toBe(200);
    expect((await r.json()).calendarSync).toBe('angestoßen');
  });

  it('Farmhouse-Kanalbuchung (Airbnb): gleicher Pfad; Tag mit pt-Block -> already-blocked, kein Schreibaufruf', async () => {
    insertRes('fh-airbnb', FARMHOUSE_LISTING, { source: '', platform: 'airbnb2' });
    getCalMock.mockResolvedValue([{ date: future(8), status: 'unavailable', blockRefs: [{ type: 'pt' }] }]);
    const r = await put('fh-airbnb', { plannedDeparture: '17:00', blockNextDay: true });
    expect(r.status).toBe(200);
    expect((await r.json()).nextDayBlock).toEqual({ applied: false, method: 'none', reason: 'Folgetag bereits geblockt (pt)', blockState: 'already-blocked', blockDate: future(8) });
    expect(setCalMock).not.toHaveBeenCalled();
    expect(getOverride('fh-airbnb')).toMatchObject({ plannedDeparture: '17:00', blockNextDay: true, blockState: 'already-blocked' });
    // Rücknahme per DELETE: already-blocked -> kein Guesty-Aufruf, 200
    getCalMock.mockClear();
    const d = await fetch(`${base}/api/agent/reservations/fh-airbnb/times`, { method: 'DELETE', headers: KEY });
    expect(d.status).toBe(200);
    expect(getCalMock).not.toHaveBeenCalled();
    expect(setCalMock).not.toHaveBeenCalled();
    expect(getOverride('fh-airbnb')).toBeNull();
  });

  it('Hostex-Objekt: Override gespeichert, KEIN Guesty-Aufruf, auch bei blockNextDay true', async () => {
    insertRes('hx-1', '12659677', { source: 'airbnb', platform: 'hostex' });
    const r = await put('hx-1', { plannedArrival: '13:00', plannedDeparture: '14:00', blockNextDay: true });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.nextDayBlock).toEqual({ applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag', blockState: null, blockDate: null });
    expect(body.times).toMatchObject({ effectiveArrival: '13:00', effectiveDeparture: '14:00' });
    expect(updateReservationMock).not.toHaveBeenCalled();
    expect(setCalMock).not.toHaveBeenCalled();
    expect(getCalMock).not.toHaveBeenCalled();
    expect(getOverride('hx-1')).toMatchObject({ plannedArrival: '13:00', blockNextDay: true });
  });

  it('Guesty-Fehler beim Block: 409 mit Details, Override bleibt gespeichert', async () => {
    insertRes('fh-airbnb', FARMHOUSE_LISTING, { source: 'airbnb2' });
    setCalMock.mockRejectedValueOnce(new ExternalApiError('Guesty API error', 400, 'guesty', { message: 'invalid range' }));
    const r = await put('fh-airbnb', { plannedDeparture: '17:00', blockNextDay: true });
    expect(r.status).toBe(409);
    expect(getOverride('fh-airbnb')!.blockState).toBeNull();
    expect(await r.json()).toMatchObject({ details: { message: 'invalid range' }, nextDayBlock: { applied: false }, times: { effectiveDeparture: '17:00' } });
    expect(getOverride('fh-airbnb')).toMatchObject({ plannedDeparture: '17:00', blockNextDay: true });
  });

  it('GET liefert effektive Zeiten ohne Guesty; DELETE nimmt Block zurück und löscht', async () => {
    insertRes('fh-airbnb', FARMHOUSE_LISTING, { source: 'airbnb2' });
    await put('fh-airbnb', { plannedDeparture: '17:00', blockNextDay: true });
    getCalMock.mockResolvedValue([{ date: future(8), status: 'unavailable', note: 'Late-Checkout fh-airbnb', blockRefs: [{ type: 'm', note: 'Late-Checkout fh-airbnb' }] }]);
    let r = await fetch(`${base}/api/agent/reservations/fh-airbnb/times`, { headers: KEY });
    expect(await r.json()).toMatchObject({ provider: 'guesty', propertySlug: 'farmhouse', times: { effectiveDeparture: '17:00', listingDefaultDeparture: '12:00' } });
    r = await fetch(`${base}/api/agent/reservations/fh-airbnb/times`, { method: 'DELETE', headers: KEY });
    expect(r.status).toBe(200);
    expect(setCalMock).toHaveBeenLastCalledWith(FARMHOUSE_LISTING, { startDate: future(8), endDate: future(8), status: 'available', note: '' });
    expect(getOverride('fh-airbnb')).toBeNull();
    r = await fetch(`${base}/api/agent/reservations/fh-airbnb/times`, { method: 'DELETE', headers: KEY });
    expect(r.status).toBe(404);
  });

  it('DELETE nach set-by-us, aber Tag inzwischen pt: kein Schreibaufruf, Override gelöscht', async () => {
    insertRes('fh-airbnb', FARMHOUSE_LISTING, { source: 'airbnb2' });
    await put('fh-airbnb', { blockNextDay: true });
    setCalMock.mockClear();
    getCalMock.mockResolvedValue([{ date: future(8), status: 'unavailable', blockRefs: [{ type: 'pt' }] }]);
    const r = await fetch(`${base}/api/agent/reservations/fh-airbnb/times`, { method: 'DELETE', headers: KEY });
    expect(r.status).toBe(200);
    expect(setCalMock).not.toHaveBeenCalled();
    expect(getOverride('fh-airbnb')).toBeNull();
  });

  it('400 (unbekanntes Feld), 404 (unbekannte Reservierung), 409 (storniert / vergangen)', async () => {
    insertRes('r1', FARMHOUSE_LISTING);
    expect((await put('r1', { price: 1 })).status).toBe(400);
    expect((await put('r1', {})).status).toBe(400);
    expect((await put('r1', { plannedDeparture: '25:99' })).status).toBe(400);
    expect((await put('nix', { plannedDeparture: '18:00' })).status).toBe(404);
    insertRes('canc', FARMHOUSE_LISTING, { status: 'canceled' });
    expect((await put('canc', { plannedDeparture: '18:00' })).status).toBe(409);
    insertRes('past', FARMHOUSE_LISTING, { check_in: '2020-01-01', check_out: '2020-01-03', check_in_localized: '2020-01-01', check_out_localized: '2020-01-03' });
    expect((await put('past', { plannedDeparture: '18:00' })).status).toBe(409);
  });

  it('Nicht-Farmhouse-Guesty-Objekt (U19): Block-Aufrufe bleiben aus', async () => {
    // U19 trägt kein Flag -> kein Guesty-Aufruf (Listing-ID aus properties.json gelesen)
    const { getPropertyBySlug } = await import('../config/properties.js');
    const u19 = getPropertyBySlug('u19')!;
    db.prepare('INSERT INTO listings (id, check_in_time, check_out_time) VALUES (?, ?, ?)').run(u19.guestyPropertyId!, '15:00:00', '12:00:00');
    insertRes('u19-1', u19.guestyPropertyId!);
    const r = await put('u19-1', { plannedArrival: '13:00', blockNextDay: true });
    expect((await r.json()).nextDayBlock).toMatchObject({ applied: false, method: 'none' });
    expect(updateReservationMock).not.toHaveBeenCalled();
    expect(setCalMock).not.toHaveBeenCalled();
  });
});
