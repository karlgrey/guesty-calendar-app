// #793: Orchestrierung — Dedupe, Provider-Filter, Env-Gate, Einhängen an ETL-Upsert.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import { notifyTimesChange, upsertReservationsTrackingTimes, type NotifierDeps } from './reservation-times-notifier.js';
import { detectTimesChange, type TimesSnapshot } from './reservation-times-change.js';
import type { StayTimeOverride } from '../repositories/stay-time-override-repository.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const FARM = { slug: 'farmhouse', provider: 'guesty', name: 'Farmhouse Prasser', shortCode: 'FH', guestyPropertyId: 'L1' };
const HOSTEX = { slug: 'as', provider: 'hostex', name: 'Alte Schilderwerkstatt', shortCode: 'AS', hostexPropertyId: 'H1' };

let db: Database.Database;
let outbox: string;

function deps(over: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    outboxDir: outbox,
    wanjaJid: 'wanja@s.whatsapp.net',
    findProperty: (listingId) => ({ L1: FARM, H1: HOSTEX } as any)[listingId],
    getListingTimes: () => ({ checkIn: '16:00', checkOut: '12:00' }),
    today: '2027-02-01',
    whatsappEnabled: true,
    ...over,
  };
}

const LDEF = { checkIn: '16:00', checkOut: '12:00' };
const snap = (o: Partial<TimesSnapshot> = {}): TimesSnapshot => ({
  reservation_id: 'res-1', listing_id: 'L1', status: 'confirmed',
  check_in: '2027-02-21', check_out: '2027-02-23', check_in_localized: '2027-02-21', check_out_localized: '2027-02-23',
  planned_arrival: null, planned_departure: null, ...o,
});

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../db/migrations/034_add_times_change_notifications.sql'), 'utf8'));
  setDatabase(db);
  outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notifier-'));
});
afterEach(() => { resetDatabase(); db.close(); fs.rmSync(outbox, { recursive: true, force: true }); });

const files = () => fs.readdirSync(outbox).filter((f) => f.endsWith('.json'));
const texts = () => files().map((f) => JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8')).text);

describe('notifyTimesChange', () => {
  const change = () => detectTimesChange(snap(), snap({ planned_departure: '18:00' }), '2027-02-01', LDEF)!;

  it('schreibt Outbox-Datei an Wanja mit Text', () => {
    notifyTimesChange(change(), deps());
    expect(texts()).toEqual(['Farmhouse, Di 23.02.: Check-out 18:00 statt 12:00 (Late-Checkout). Micha']);
    expect(JSON.parse(fs.readFileSync(path.join(outbox, files()[0]), 'utf8')).chatJid).toBe('wanja@s.whatsapp.net');
  });

  it('idempotent: zweiter Lauf mit derselben Änderung schreibt nicht', () => {
    notifyTimesChange(change(), deps());
    notifyTimesChange(change(), deps());
    expect(files()).toHaveLength(1);
  });

  it('neuer Wert = neue Nachricht', () => {
    notifyTimesChange(change(), deps());
    notifyTimesChange(detectTimesChange(snap({ planned_departure: '18:00' }), snap({ planned_departure: '19:00' }), '2027-02-01')!, deps());
    expect(files()).toHaveLength(2);
  });

  it('ohne WA_OUTBOX_DIR: kein Versand, kein Dedupe-Eintrag (nur Log)', () => {
    notifyTimesChange(change(), deps({ outboxDir: undefined }));
    expect(files()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM times_change_notifications').get()).toEqual({ c: 0 });
  });

  it('Hostex-Objekt -> kein Versand', () => {
    const c = detectTimesChange(snap({ listing_id: 'H1' }), snap({ listing_id: 'H1', planned_departure: '18:00' }), '2027-02-01', LDEF)!;
    notifyTimesChange(c, deps());
    expect(files()).toHaveLength(0);
  });

  it('unbekanntes Listing -> kein Versand', () => {
    const c = detectTimesChange(snap({ listing_id: 'X' }), snap({ listing_id: 'X', planned_departure: '18:00' }), '2027-02-01', LDEF)!;
    notifyTimesChange(c, deps());
    expect(files()).toHaveLength(0);
  });

  it('Schreibfehler gibt den Dedupe-Claim wieder frei und wirft nicht', () => {
    notifyTimesChange(change(), deps({ outboxDir: path.join(outbox, 'fehlt') }));
    expect(db.prepare('SELECT COUNT(*) c FROM times_change_notifications').get()).toEqual({ c: 0 });
    notifyTimesChange(change(), deps());
    expect(files()).toHaveLength(1);
  });
});

describe('upsertReservationsTrackingTimes (ETL-/Spiegel-Einhängung)', () => {
  beforeEach(() => {
    db.exec(`CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT, check_in TEXT, check_out TEXT,
      check_in_localized TEXT, check_out_localized TEXT, status TEXT, planned_arrival TEXT, planned_departure TEXT)`);
    db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, status)
      VALUES ('res-1','L1','2027-02-21','2027-02-23','2027-02-21','2027-02-23','confirmed')`).run();
  });
  const upsertFn = (planned: string | null) => (rows: any[]) => {
    for (const r of rows) db.prepare('UPDATE reservations SET planned_departure = ? WHERE reservation_id = ?').run(planned, r.reservation_id);
    return rows.length;
  };

  it('Differenz nach Upsert löst genau eine Nachricht aus; zweiter Lauf (ETL nach Spiegel) nicht', () => {
    const rows = [{ reservation_id: 'res-1' }] as any;
    expect(upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps())).toBe(1);
    expect(texts()).toHaveLength(1);
    upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps());
    expect(texts()).toHaveLength(1);
  });

  it('AVOW-Fehlalarm: NULL -> Standardzeiten (PATCH-Spiegel) + Datumsänderung -> nur "dates"', () => {
    const rows = [{ reservation_id: 'res-1' }] as any;
    const mirror = (r: any[]) => {
      for (const x of r) {
        db.prepare(`UPDATE reservations SET check_in_localized='2027-02-20', check_out_localized='2027-02-22',
          planned_arrival='08:00', planned_departure='12:00' WHERE reservation_id = ?`).run(x.reservation_id);
      }
      return r.length;
    };
    upsertReservationsTrackingTimes(rows, mirror, deps({ getListingTimes: () => ({ checkIn: '08:00:00', checkOut: '12:00:00' }) }));
    expect(texts()).toEqual(['Farmhouse: neu 20.–22.02. (statt 21.–23.02.). Micha']);
  });

  it('neue Reservierung (kein Vorher-Stand) -> keine Nachricht', () => {
    const rows = [{ reservation_id: 'neu' }] as any;
    db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, status) VALUES ('neu','L1','2027-03-01','2027-03-03','confirmed')`).run();
    const insertOnly = (r: any[]) => r.length;
    expect(upsertReservationsTrackingTimes(rows, insertOnly, deps())).toBe(1);
    expect(files()).toHaveLength(0);
  });

  it('Tracking-Fehler brechen den Upsert nicht', () => {
    const rows = [{ reservation_id: 'res-1' }] as any;
    expect(upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps({ findProperty: () => { throw new Error('boom'); } }))).toBe(1);
  });
});

// #799: Wanja-WhatsApp hinter TIMES_CHANGE_WHATSAPP (Default aus) + Konflikt-Logzeile
describe('upsertReservationsTrackingTimes — #799', () => {
  beforeEach(() => {
    db.exec(`CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT, check_in TEXT, check_out TEXT,
      check_in_localized TEXT, check_out_localized TEXT, status TEXT, planned_arrival TEXT, planned_departure TEXT)`);
    db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, status)
      VALUES ('res-1','L1','2027-02-21','2027-02-23','2027-02-21','2027-02-23','confirmed')`).run();
  });
  const upsertFn = (planned: string | null, arrival: string | null = null) => (rows: any[]) => {
    for (const r of rows) db.prepare('UPDATE reservations SET planned_departure = ?, planned_arrival = ? WHERE reservation_id = ?').run(planned, arrival, r.reservation_id);
    return rows.length;
  };
  const rows = [{ reservation_id: 'res-1' }] as any;
  const ov = (o: Partial<StayTimeOverride>): StayTimeOverride => ({
    reservationId: 'res-1', plannedArrival: null, plannedDeparture: null, blockNextDay: false, note: null,
    source: 'agent', createdAt: 'x', updatedAt: 'x', ...o,
  });

  it('Standard-Env (Flag aus): Notifier wird nicht aufgerufen, kein Outbox-Eintrag', () => {
    expect(upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps({ whatsappEnabled: undefined }))).toBe(1);
    expect(files()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM times_change_notifications').get()).toEqual({ c: 0 });
  });

  it('Flag explizit aus: kein Versand', () => {
    upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps({ whatsappEnabled: false }));
    expect(files()).toHaveLength(0);
  });

  it('Flag an: wie bisher', () => {
    upsertReservationsTrackingTimes(rows, upsertFn('18:00'), deps({ whatsappEnabled: true }));
    expect(texts()).toHaveLength(1);
  });

  it('Konflikt: Provider schreibt abweichende Zeit -> Logzeile, Override bleibt (ein Lookup)', async () => {
    const logger = (await import('../utils/logger.js')).default as any;
    logger.info.mockClear();
    const getOverrides = vi.fn(() => new Map([['res-1', ov({ plannedDeparture: '18:00' })]]));
    upsertReservationsTrackingTimes(rows, upsertFn('15:00'), deps({ whatsappEnabled: false, getOverrides }));
    expect(getOverrides).toHaveBeenCalledTimes(1);
    expect(getOverrides).toHaveBeenCalledWith(['res-1']);
    expect(logger.info).toHaveBeenCalledWith(
      { reservationId: 'res-1', field: 'planned_departure', override: '18:00', provider: '15:00' },
      'override weicht vom Provider ab',
    );
  });

  it('kein Konflikt-Log bei gleichem Wert oder wenn der Override das Feld nicht setzt', async () => {
    const logger = (await import('../utils/logger.js')).default as any;
    logger.info.mockClear();
    const getOverrides = () => new Map([['res-1', ov({ plannedDeparture: '15:00', plannedArrival: null })]]);
    upsertReservationsTrackingTimes(rows, upsertFn('15:00', '14:00'), deps({ whatsappEnabled: false, getOverrides }));
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'override weicht vom Provider ab');
  });

  it('Reservierungen ohne geänderte planned_* lösen keinen Override-Lookup aus', () => {
    const getOverrides = vi.fn(() => new Map());
    upsertReservationsTrackingTimes(rows, (r: any[]) => r.length, deps({ getOverrides }));
    expect(getOverrides).not.toHaveBeenCalled();
  });

  it('Override-Lookup wirft (z. B. Tabelle fehlt) -> Upsert bleibt heil', () => {
    const getOverrides = () => { throw new Error('no such table'); };
    expect(upsertReservationsTrackingTimes(rows, upsertFn('15:00'), deps({ whatsappEnabled: false, getOverrides }))).toBe(1);
  });
});
