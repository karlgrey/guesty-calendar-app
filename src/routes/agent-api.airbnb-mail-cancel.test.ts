// #1143: Storno einer airbnb-mail-Reservierung über die Agent-API, Ende zu Ende (echte DB + properties.json, Google-Client gemockt).
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
const deleteEventMock = vi.fn();
vi.mock('../services/google-calendar-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/google-calendar-client.js')>()),
  googleCalendarClient: { deleteEvent: (...a: unknown[]) => deleteEventMock(...a) },
}));

import agentApiRoutes from './agent-api.js';
import { toGoogleEventId } from '../services/google-event-id.js';
import { getPropertyBySlug } from '../config/properties.js';

const LOFT_LISTING = '1678837365136764301';
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

function insertRes(id: string, over: Record<string, unknown> = {}) {
  const r = {
    reservation_id: id, listing_id: LOFT_LISTING, check_in: future(5), check_out: future(7),
    check_in_localized: future(5), check_out_localized: future(7), nights_count: 2,
    status: 'confirmed', source: 'airbnb', platform: 'airbnb-mail', host_payout: 1234, ...over,
  };
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, source, platform, host_payout, last_synced_at)
    VALUES (@reservation_id, @listing_id, @check_in, @check_out, @check_in_localized, @check_out_localized, @nights_count, @status, @source, @platform, @host_payout, 'x')`).run(r);
}
function insertInquiry(id: string, listing = LOFT_LISTING) {
  db.prepare(`INSERT INTO inquiries (inquiry_id, listing_id, status, check_in, check_out, last_synced_at) VALUES (?, ?, 'confirmed', ?, ?, 'x')`)
    .run(id, listing, future(5), future(7));
}
const resRow = (id: string) => db.prepare('SELECT * FROM reservations WHERE reservation_id = ?').get(id) as any;
const post = (code: string, body?: unknown, headers: Record<string, string> = KEY) =>
  fetch(`${base}/api/agent/airbnb-mail/reservations/${code}/cancel`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  deleteEventMock.mockResolvedValue(true);
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO listings (id) VALUES ('${LOFT_LISTING}'), ('${FARMHOUSE_LISTING}');`);
  for (const m of ['002_add_reservations_table.sql', '003_add_inquiries_table.sql', '012_add_guest_fingerprint.sql']) {
    db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
  }
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('POST /airbnb-mail/reservations/:code/cancel (#1143)', () => {
  it('Erfolg: Status canceled, Zeile + Payout bleiben, Event gelöscht', async () => {
    insertRes('HMQH3PSK82'); insertInquiry('HMQH3PSK82');
    const res = await post('HMQH3PSK82');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'HMQH3PSK82', property: 'firenze-loft', previousStatus: 'confirmed', status: 'canceled', calendarEventDeleted: true, alreadyCanceled: false });
    const row = resRow('HMQH3PSK82');
    expect(row.status).toBe('canceled');
    expect(row.host_payout).toBe(1234);
    expect((db.prepare(`SELECT status FROM inquiries WHERE inquiry_id='HMQH3PSK82'`).get() as any).status).toBe('canceled');
    const calId = getPropertyBySlug('firenze-loft')!.googleCalendar!.calendarId;
    expect(deleteEventMock).toHaveBeenCalledTimes(1);
    expect(deleteEventMock).toHaveBeenCalledWith(calId, toGoogleEventId('HMQH3PSK82'));
  });

  it('404 vom Kalender (deleteEvent → false) zählt als Erfolg', async () => {
    insertRes('HMQH3PSK82');
    deleteEventMock.mockResolvedValue(false);
    const body: any = await (await post('HMQH3PSK82')).json();
    expect(body.calendarEventDeleted).toBe(true);
  });

  it('Kalenderfehler: 200, calendarEventDeleted false, DB trotzdem canceled', async () => {
    insertRes('HMQH3PSK82');
    deleteEventMock.mockRejectedValue(new Error('boom'));
    const res = await post('HMQH3PSK82');
    expect(res.status).toBe(200);
    expect((await res.json() as any).calendarEventDeleted).toBe(false);
    expect(resRow('HMQH3PSK82').status).toBe('canceled');
  });

  it('idempotent: zweiter Aufruf alreadyCanceled, Retry löscht Event erneut', async () => {
    insertRes('HMQH3PSK82');
    await post('HMQH3PSK82');
    const res = await post('HMQH3PSK82');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyCanceled: true, previousStatus: 'canceled', status: 'canceled', calendarEventDeleted: true });
    expect(deleteEventMock).toHaveBeenCalledTimes(2);
  });

  it('ohne inquiries-Zeile, negativer Payout bleibt', async () => {
    insertRes('HMKANDA001', { host_payout: -212 });
    const res = await post('HMKANDA001');
    expect(res.status).toBe(200);
    expect(resRow('HMKANDA001').host_payout).toBe(-212);
    expect(resRow('HMKANDA001').status).toBe('canceled');
  });

  it('platform airbnb-ical ist erlaubt', async () => {
    insertRes('HMICAL0001', { platform: 'airbnb-ical' });
    expect((await post('HMICAL0001')).status).toBe(200);
    expect(resRow('HMICAL0001').status).toBe('canceled');
  });

  it.each([
    ['direct', 'HMDIRECT01', LOFT_LISTING],
    ['airbnb2', 'HMAIRBNB02', LOFT_LISTING],
    ['airbnb2', '6a2720bb1234567890abcdef', FARMHOUSE_LISTING],
  ])('falsche Plattform %s (%s) → 409, nichts geändert', async (platform, id, listing) => {
    insertRes(id, { platform, listing_id: listing });
    const res = await post(id);
    expect(res.status).toBe(409);
    expect(resRow(id).status).toBe('confirmed');
    expect(deleteEventMock).not.toHaveBeenCalled();
  });

  it('unbekannter Code → 404', async () => {
    expect((await post('HMNOPE0000')).status).toBe(404);
  });

  it('Kleinschreibung findet die Zeile', async () => {
    insertRes('HMQH3PSK82');
    const res = await post('hmqh3psk82');
    expect(res.status).toBe(200);
    expect((await res.json() as any).code).toBe('HMQH3PSK82');
  });

  it('reason: leer/Zahl → 400, String → 200', async () => {
    insertRes('HMQH3PSK82');
    expect((await post('HMQH3PSK82', { reason: '' })).status).toBe(400);
    expect((await post('HMQH3PSK82', { reason: 123 })).status).toBe(400);
    expect(resRow('HMQH3PSK82').status).toBe('confirmed');
    expect((await post('HMQH3PSK82', { reason: 'Gast storniert' })).status).toBe(200);
  });

  it('ohne X-Agent-Key → 401', async () => {
    insertRes('HMQH3PSK82');
    const res = await post('HMQH3PSK82', undefined, {});
    expect(res.status).toBe(401);
    expect(resRow('HMQH3PSK82').status).toBe('confirmed');
  });
});
