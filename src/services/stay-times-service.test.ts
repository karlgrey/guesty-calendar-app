// #799: gemeinsamer Service für Agent-API und Admin-Formular
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const applyMock = vi.fn();
vi.mock('./next-day-block.js', () => ({ applyNextDayBlock: (...a: unknown[]) => applyMock(...a) }));
const syncMock = vi.fn();
vi.mock('../jobs/sync-google-calendar.js', () => ({ syncGoogleCalendarForProperty: (...a: unknown[]) => syncMock(...a) }));

const FARM = { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'L-FH', blocksNextDayOnLateCheckout: true, googleCalendar: { enabled: true, calendarId: 'c' } };
const HOSTEX = { slug: 'bootshaus-alte-oder', provider: 'hostex', hostexPropertyId: 'L-HX', googleCalendar: { enabled: true, calendarId: 'c2', checkInTime: '15:00', checkOutTime: '12:00' } };
const NOCAL = { slug: 'u19', provider: 'guesty', guestyPropertyId: 'L-U19', googleCalendar: { enabled: false } };
vi.mock('../config/properties.js', () => ({
  findPropertyByListingId: (id: string) => ({ 'L-FH': FARM, 'L-HX': HOSTEX, 'L-U19': NOCAL } as any)[id],
}));

import {
  setStayTimes, deleteStayTimes, getStayTimes, STAY_TIMES_ALLOWED_FIELDS,
} from './stay-times-service.js';
import { getOverride, upsertOverride } from '../repositories/stay-time-override-repository.js';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors.js';

let db: Database.Database;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
const TODAY = '2026-10-02';

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, check_in_time TEXT, check_out_time TEXT, taxes TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO listings (id, check_in_time, check_out_time) VALUES ('L-FH','08:00:00','12:00:00'), ('L-HX','15:00:00','12:00:00'), ('L-U19','15:00:00','12:00:00');`);
  db.exec(readFileSync(join(migrationsDir, '002_add_reservations_table.sql'), 'utf-8'));
  db.exec(readFileSync(join(migrationsDir, '012_add_guest_fingerprint.sql'), 'utf-8'));
  db.exec(readFileSync(join(migrationsDir, '035_add_stay_time_overrides.sql'), 'utf-8'));
  setDatabase(db);
  applyMock.mockResolvedValue({ applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag' });
  syncMock.mockResolvedValue({ success: true, eventsUpserted: 1, eventsDeleted: 0 });
});
afterEach(() => { resetDatabase(); db.close(); });

function insertRes(id: string, over: Record<string, unknown> = {}) {
  const r = {
    reservation_id: id, listing_id: 'L-FH', check_in: '2026-12-01', check_out: '2026-12-03',
    check_in_localized: '2026-12-01', check_out_localized: '2026-12-03', nights_count: 2,
    status: 'confirmed', source: 'manual', platform: 'direct', planned_arrival: null, planned_departure: null, ...over,
  };
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, source, platform, planned_arrival, planned_departure, last_synced_at)
    VALUES (@reservation_id, @listing_id, @check_in, @check_out, @check_in_localized, @check_out_localized, @nights_count, @status, @source, @platform, @planned_arrival, @planned_departure, 'x')`).run(r);
}
const put = (id: string, body: unknown, source: 'agent' | 'admin' = 'agent') => setStayTimes(id, body, source, { today: TODAY });

describe('Validierung', () => {
  beforeEach(() => insertRes('r1'));
  it.each([
    [{}, /leer/],
    [[], /JSON-Objekt/],
    [null, /JSON-Objekt/],
    [{ price: 5 }, /Unbekannte Felder: price/],
    [{ plannedArrival: '25:00' }, /plannedArrival must be HH:MM/],
    [{ plannedDeparture: '9:00' }, /plannedDeparture must be HH:MM/],
    [{ plannedDeparture: 1800 }, /plannedDeparture must be HH:MM/],
    [{ blockNextDay: 'ja' }, /blockNextDay/],
    [{ blockNextDay: null }, /blockNextDay/],
    [{ note: 5 }, /note/],
    [{ note: 'x'.repeat(501) }, /500/],
  ])('%j -> 400', async (body, msg) => {
    await expect(put('r1', body)).rejects.toBeInstanceOf(ValidationError);
    await expect(put('r1', body)).rejects.toThrow(msg as RegExp);
    expect(getOverride('r1')).toBeNull();
  });
  it('Fehlermeldung nennt erlaubte Felder', async () => {
    await expect(put('r1', { x: 1 })).rejects.toThrow(STAY_TIMES_ALLOWED_FIELDS.join(', '));
  });
  it('plannedDeparture null und note null sind gültig (zurücksetzen)', async () => {
    await expect(put('r1', { plannedDeparture: null, note: null })).resolves.toMatchObject({ ok: true });
  });
});

describe('Guards', () => {
  it('unbekannte Reservierung -> 404', async () => {
    await expect(put('nix', { plannedDeparture: '18:00' })).rejects.toBeInstanceOf(NotFoundError);
  });
  it('Status canceled -> 409', async () => {
    insertRes('r1', { status: 'canceled' });
    await expect(put('r1', { plannedDeparture: '18:00' })).rejects.toBeInstanceOf(ConflictError);
    await expect(put('r1', { plannedDeparture: '18:00' })).rejects.toThrow(/Status 'canceled'/);
  });
  it('Check-out in der Vergangenheit -> 409', async () => {
    insertRes('r1', { check_in_localized: '2026-09-28', check_out_localized: '2026-10-01', check_in: '2026-09-28', check_out: '2026-10-01' });
    await expect(put('r1', { plannedDeparture: '18:00' })).rejects.toThrow(/Check-out.*liegt in der Vergangenheit/);
  });
  it('Check-out heute ist erlaubt (Late-Checkout am Abreisetag)', async () => {
    insertRes('r1', { check_in_localized: '2026-09-30', check_out_localized: '2026-10-02', check_in: '2026-09-30', check_out: '2026-10-02' });
    await expect(put('r1', { plannedDeparture: '18:00' })).resolves.toMatchObject({ ok: true });
  });
  it('Status reserved ist erlaubt', async () => {
    insertRes('r1', { status: 'reserved' });
    await expect(put('r1', { plannedDeparture: '18:00' })).resolves.toMatchObject({ ok: true });
  });
  it('DELETE ohne Override -> 404', async () => {
    insertRes('r1');
    await expect(deleteStayTimes('r1', { today: TODAY })).rejects.toBeInstanceOf(NotFoundError);
  });
  it('DELETE bei unbekannter Reservierung -> 404; bei Status canceled -> 409', async () => {
    await expect(deleteStayTimes('nix', { today: TODAY })).rejects.toBeInstanceOf(NotFoundError);
    insertRes('r2', { status: 'canceled' });
    upsertOverride({ reservationId: 'r2', plannedDeparture: '18:00', source: 'agent' });
    await expect(deleteStayTimes('r2', { today: TODAY })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('PUT — Erfolg', () => {
  it('Guesty-Reservierung: speichert Override, liefert effektive Zeiten und source agent', async () => {
    insertRes('r1');
    const r = await put('r1', { plannedDeparture: '18:00', note: 'per Chat zugesagt' });
    expect(r.ok).toBe(true);
    expect(r.reservationId).toBe('r1');
    expect(r.times).toMatchObject({
      effectiveDeparture: '18:00', departureSource: 'override', effectiveArrival: '08:00', arrivalSource: 'default',
      listingDefaultDeparture: '12:00', listingDefaultArrival: '08:00',
      override: { plannedDeparture: '18:00', plannedArrival: null, blockNextDay: false, note: 'per Chat zugesagt', source: 'agent' },
    });
    expect(r.nextDayBlock).toEqual({ applied: false, method: 'none', reason: 'blockNextDay nicht angefragt' });
    expect(r.calendarSynced).toBe(true);
    expect(getOverride('r1')!.source).toBe('agent');
  });

  it('Hostex-Reservierung: funktioniert genauso, Kalender-Sync für das Hostex-Objekt', async () => {
    insertRes('rh', { listing_id: 'L-HX', source: 'airbnb', platform: 'hostex' });
    const r = await put('rh', { plannedArrival: '13:00' });
    expect(r.times).toMatchObject({ effectiveArrival: '13:00', arrivalSource: 'override', providerArrival: null });
    expect(syncMock).toHaveBeenCalledWith(HOSTEX);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('source admin wird gespeichert', async () => {
    insertRes('r1');
    await put('r1', { plannedArrival: '07:00' }, 'admin');
    expect(getOverride('r1')!.source).toBe('admin');
  });

  it('Teilmenge: zweiter PUT lässt vorhandene Felder stehen; null setzt zurück', async () => {
    insertRes('r1');
    await put('r1', { plannedDeparture: '18:00', note: 'a' });
    await put('r1', { plannedArrival: '07:00' });
    expect(getOverride('r1')).toMatchObject({ plannedArrival: '07:00', plannedDeparture: '18:00', note: 'a' });
    const r = await put('r1', { plannedDeparture: null });
    expect(r.times.effectiveDeparture).toBe('12:00');
    expect(r.times.departureSource).toBe('default');
  });

  it('Kalender-Sync scheitert -> calendarSynced false, Override bleibt', async () => {
    insertRes('r1');
    syncMock.mockResolvedValueOnce({ success: false, error: 'x' });
    const r = await put('r1', { plannedDeparture: '18:00' });
    expect(r.calendarSynced).toBe(false);
    expect(r.calendarSync).toBe('nächster Lauf');
    expect(getOverride('r1')).not.toBeNull();
  });

  it('Kalender-Sync wirft -> non-fatal', async () => {
    insertRes('r1');
    syncMock.mockRejectedValueOnce(new Error('boom'));
    await expect(put('r1', { plannedDeparture: '18:00' })).resolves.toMatchObject({ calendarSynced: false });
  });

  it('Objekt ohne aktiven Google-Kalender: kein Sync-Aufruf', async () => {
    insertRes('r1', { listing_id: 'L-U19' });
    const r = await put('r1', { plannedDeparture: '18:00' });
    expect(syncMock).not.toHaveBeenCalled();
    expect(r.calendarSynced).toBe(false);
  });
});

describe('PUT — Folgetag-Block', () => {
  beforeEach(() => insertRes('r1'));

  it('blockNextDay true -> applyNextDayBlock(target, true) mit lokalen Daten', async () => {
    applyMock.mockResolvedValueOnce({ applied: true, method: 'reservation' });
    const r = await put('r1', { plannedDeparture: '18:00', blockNextDay: true });
    expect(applyMock).toHaveBeenCalledWith({ reservationId: 'r1', listingId: 'L-FH', source: 'manual', checkOutDay: '2026-12-03' }, true);
    expect(r.nextDayBlock).toEqual({ applied: true, method: 'reservation' });
    expect(getOverride('r1')!.blockNextDay).toBe(true);
  });

  it('ohne blockNextDay im Body: kein Block-Aufruf', async () => {
    const r = await put('r1', { plannedDeparture: '18:00' });
    expect(applyMock).not.toHaveBeenCalled();
    expect(r.nextDayBlock).toMatchObject({ applied: false, method: 'none' });
  });

  it('blockNextDay false ohne vorherigen Block: kein Guesty-Aufruf', async () => {
    await put('r1', { blockNextDay: false });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('blockNextDay false nach vorherigem true: Rücknahme', async () => {
    applyMock.mockResolvedValue({ applied: true, method: 'reservation' });
    await put('r1', { blockNextDay: true });
    await put('r1', { blockNextDay: false });
    expect(applyMock).toHaveBeenLastCalledWith(expect.objectContaining({ reservationId: 'r1' }), false);
  });

  it('Guesty-Fehler: Override wird TROTZDEM gespeichert, Ergebnis trägt blockError', async () => {
    applyMock.mockResolvedValueOnce({ applied: false, method: 'listing-calendar', reason: 'Guesty-Aufruf fehlgeschlagen: x', error: { message: 'x', details: { a: 1 } } });
    const r = await put('r1', { plannedDeparture: '18:00', blockNextDay: true });
    expect(getOverride('r1')).toMatchObject({ plannedDeparture: '18:00', blockNextDay: true });
    expect(r.nextDayBlock).toMatchObject({ applied: false, method: 'listing-calendar', reason: expect.stringContaining('Guesty') });
    expect(r.blockError).toEqual({ message: 'x', details: { a: 1 } });
    expect(r.nextDayBlock).not.toHaveProperty('error');
  });
});

describe('DELETE', () => {
  it('löscht den Override und hebt gesetzten Block auf', async () => {
    insertRes('r1');
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', blockNextDay: true, source: 'agent' });
    applyMock.mockResolvedValueOnce({ applied: true, method: 'reservation' });
    const r = await deleteStayTimes('r1', { today: TODAY });
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'r1' }), false);
    expect(getOverride('r1')).toBeNull();
    expect(r).toMatchObject({ ok: true, reservationId: 'r1', nextDayBlock: { applied: true }, calendarSynced: true });
    expect(r.times.override).toBeNull();
  });

  it('ohne gesetzten Block: kein Guesty-Aufruf', async () => {
    insertRes('r1');
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', source: 'agent' });
    await deleteStayTimes('r1', { today: TODAY });
    expect(applyMock).not.toHaveBeenCalled();
    expect(getOverride('r1')).toBeNull();
  });

  it('Rücknahme des Blocks scheitert: Override bleibt (Retry möglich), blockError gesetzt', async () => {
    insertRes('r1');
    upsertOverride({ reservationId: 'r1', plannedDeparture: '18:00', blockNextDay: true, source: 'agent' });
    applyMock.mockResolvedValueOnce({ applied: false, method: 'reservation', reason: 'Guesty-Aufruf fehlgeschlagen: x', error: { message: 'x' } });
    const r = await deleteStayTimes('r1', { today: TODAY });
    expect(getOverride('r1')).not.toBeNull();
    expect(r.blockError).toEqual({ message: 'x' });
  });
});

describe('getStayTimes', () => {
  it('liefert Ansicht für Hostex ohne Override', () => {
    insertRes('rh', { listing_id: 'L-HX', planned_departure: '14:00', source: 'airbnb', platform: 'hostex' });
    const v = getStayTimes('rh')!;
    expect(v).toMatchObject({ reservationId: 'rh', provider: 'hostex', propertySlug: 'bootshaus-alte-oder', checkIn: '2026-12-01', checkOut: '2026-12-03', status: 'confirmed' });
    expect(v.times).toMatchObject({
      effectiveDeparture: '14:00', providerDeparture: '14:00', listingDefaultDeparture: '12:00', override: null,
    });
  });
  it('null ohne lokale Zeile', () => {
    expect(getStayTimes('nix')).toBeNull();
  });
  it('Listing-Standard fällt auf googleCalendar-Zeiten zurück, wenn das Listing keine hat', () => {
    db.exec(`UPDATE listings SET check_in_time = NULL, check_out_time = NULL WHERE id = 'L-HX'`);
    insertRes('rh', { listing_id: 'L-HX' });
    expect(getStayTimes('rh')!.times).toMatchObject({ listingDefaultArrival: '15:00', listingDefaultDeparture: '12:00' });
  });
});
