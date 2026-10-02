// #793: Orchestrierung — Dedupe, Provider-Filter, Env-Gate, Einhängen an ETL-Upsert.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import { notifyTimesChange, upsertReservationsTrackingTimes, type NotifierDeps } from './reservation-times-notifier.js';
import { detectTimesChange, type TimesSnapshot } from './reservation-times-change.js';

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
    ...over,
  };
}

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
  const change = () => detectTimesChange(snap(), snap({ planned_departure: '18:00' }), '2027-02-01')!;

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
    const c = detectTimesChange(snap({ listing_id: 'H1' }), snap({ listing_id: 'H1', planned_departure: '18:00' }), '2027-02-01')!;
    notifyTimesChange(c, deps());
    expect(files()).toHaveLength(0);
  });

  it('unbekanntes Listing -> kein Versand', () => {
    const c = detectTimesChange(snap({ listing_id: 'X' }), snap({ listing_id: 'X', planned_departure: '18:00' }), '2027-02-01')!;
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
