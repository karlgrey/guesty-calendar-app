// #1376: Strom-Mail je Gast — Auswahl (pure) und Lauf (:memory:-DB, sendEmail gemockt)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const sendEmailMock = vi.fn();
vi.mock('../services/email-service.js', () => ({ sendEmail: (...a: unknown[]) => sendEmailMock(...a) }));
vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, baseUrl: 'https://app.example.com/' } };
});

let reportingUntilOverride: string | undefined;
vi.mock('../config/properties.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    getPropertyBySlug: (slug: string) => {
      const p = mod.getPropertyBySlug(slug);
      return p && reportingUntilOverride ? { ...p, reportingUntil: reportingUntilOverride } : p;
    },
  };
});

import { POWER_STAY_FALLBACK_MS, POWER_STAY_SINCE_KEY, runPowerStayMails, selectDuePowerStays } from './power-stay-email.js';
import logger from '../utils/logger.js';
import { insertMeterReading } from '../repositories/meter-reading-repository.js';
import { addRecipient, setSubscription } from '../repositories/report-recipient-repository.js';
import { getSchedulerState, setSchedulerState } from '../repositories/scheduler-state-repository.js';
import { buildPowerReport, type PowerReport } from '../services/power-report-service.js';
import type { PowerRow } from '../services/power-consumption.js';
import { num } from '../services/power-format.js';

const FH = '686d1e927ae7af00234115ad';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
let db: Database.Database;

const SINCE = '2026-11-22T00:00:00.000Z';
// Buchung 20.–22.11.: Check-in 16:00 Berlin = 15:00Z, Check-out 11:00 Berlin = 10:00Z
const CHECKOUT = Date.parse('2026-11-22T10:00:00.000Z');
const H = 3600_000;

beforeEach(() => {
  reportingUntilOverride = undefined;
  sendEmailMock.mockReset().mockResolvedValue(true);
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, check_in_time TEXT, check_out_time TEXT, taxes TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);`);
  for (const m of [
    '002_add_reservations_table.sql', '012_add_guest_fingerprint.sql', '026_add_scheduler_state.sql', '035_add_stay_time_overrides.sql',
    '036_add_stay_time_override_block_state.sql', '037_add_stay_time_override_block_date.sql', '041_add_report_recipients.sql',
    '044_add_meter_readings.sql', '045_calendar_weekly_per_property.sql', '047_power_stay_mail.sql',
  ]) {
    db.exec(readFileSync(join(migrationsDir, m), 'utf-8'));
  }
  db.prepare(`INSERT INTO listings (id, check_in_time, check_out_time) VALUES (?, '16:00', '11:00')`).run(FH);
  setDatabase(db);
  setSchedulerState(POWER_STAY_SINCE_KEY, SINCE);
});
afterEach(() => { resetDatabase(); db.close(); });

function insertRes(id: string, checkIn: string, checkOut: string, status = 'confirmed', nights = 2, guest = `Gast ${id}`) {
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, guest_name, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x')`).run(id, FH, `${checkIn}T15:00:00.000Z`, `${checkOut}T10:00:00.000Z`, checkIn, checkOut, nights, status, guest);
}
/** stündliche Stände (UTC) von from bis to, `rate` kWh/h (Funktion des Zeitpunkts) */
function readings(fromIso: string, toIso: string, rate: (t: number) => number = () => 1) {
  let kwh = 1000;
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += H) {
    insertMeterReading('farmhouse', new Date(t).toISOString(), kwh);
    kwh += rate(t);
  }
}
function recipient(email = 'a@example.com', active = true) {
  const r = addRecipient(email);
  setSubscription(r.id, 'power-stay', 'farmhouse', active);
  return r;
}
const mailRows = () => db.prepare('SELECT * FROM power_stay_mails').all() as Array<Record<string, unknown>>;

describe('runPowerStayMails', () => {
  it('sendet genau einmal (auch im zweiten Lauf nicht), Vermerk complete', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient('a@example.com');
    recipient('b@example.com');
    const now = new Date(CHECKOUT + 2.5 * H);

    const r1 = await runPowerStayMails(now);
    expect(r1).toMatchObject({ sent: 1, failed: 0 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.to).toEqual(['a@example.com', 'b@example.com']);
    expect(arg.subject).toMatch(/^Strom Farmhouse Prasser: Gast r1 · /);
    expect(arg.html).toContain('https://app.example.com/admin/strom?property=farmhouse');
    expect(mailRows()).toEqual([expect.objectContaining({ reservation_id: 'r1', property_slug: 'farmhouse', completeness: 'complete', recipient_count: 2, check_out_utc: '2026-11-22T10:00:00.000Z' })]);

    vi.resetModules(); // „frischer“ Modulzustand: der Vermerk liegt in der DB, nicht im RAM
    const fresh = await import('./power-stay-email.js');
    const r2 = await fresh.runPowerStayMails(new Date(CHECKOUT + 3.5 * H));
    expect(r2.sent).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('Zahlen in der Mail = Zeile aus buildPowerReport (/admin/strom)', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    const now = new Date(CHECKOUT + 2.5 * H);
    await runPowerStayMails(now);
    const row = buildPowerReport('farmhouse', now).rows.find((r) => r.reservationId === 'r1')!;
    expect(row.kwh).not.toBeNull();
    const { html, text, subject } = sendEmailMock.mock.calls[0][0];
    for (const out of [html, text]) {
      expect(out).toContain(num(row.kwh!));
      expect(out).toContain(num(row.kwhPerNight!));
    }
    expect(subject).toContain(`${num(row.kwhPerNight!)} kWh/Nacht`);
  });

  it('wartet: Check-out vorbei, noch kein Stand danach, < 6 h → keine Mail, kein Vermerk', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T08:00:00.000Z');
    recipient();
    const r = await runPowerStayMails(new Date(CHECKOUT + 2 * H));
    expect(r.sent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mailRows()).toEqual([]);
  });

  it('Messlücke nach 6 h: Mail „unvollständig (Messlücke)“, Vermerk incomplete', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T08:00:00.000Z');
    recipient();
    const r = await runPowerStayMails(new Date(CHECKOUT + POWER_STAY_FALLBACK_MS));
    expect(r.sent).toBe(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe('Strom Farmhouse Prasser: Gast r1 · unvollständig (Messlücke)');
    expect(mailRows()[0]).toMatchObject({ reservation_id: 'r1', completeness: 'incomplete' });
  });

  it('alt: Check-out vor dem Stichtag → keine Mail', async () => {
    insertRes('alt', '2026-11-16', '2026-11-18');
    readings('2026-11-15T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    const r = await runPowerStayMails(new Date(CHECKOUT + 3 * H));
    expect(r.sent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mailRows()).toEqual([]);
  });

  it.each(['canceled', 'reserved'])('Status %s → keine Mail', async (status) => {
    insertRes('x', '2026-11-20', '2026-11-22', status);
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    await runPowerStayMails(new Date(CHECKOUT + 3 * H));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mailRows()).toEqual([]);
  });

  it('ohne aktiven Empfänger: keine Mail, kein Vermerk; nach Häkchen sendet der nächste Lauf', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    const now = new Date(CHECKOUT + 3 * H);
    await runPowerStayMails(now); // gar kein Empfänger
    const r = recipient('a@example.com', false); // Empfänger, Häkchen inaktiv
    await runPowerStayMails(now);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mailRows()).toEqual([]);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.objectContaining({ propertySlug: 'farmhouse' }), expect.stringContaining('keine Empfänger'));

    setSubscription(r.id, 'power-stay', 'farmhouse', true);
    expect((await runPowerStayMails(now)).sent).toBe(1);
    expect(mailRows()).toHaveLength(1);
  });

  it('Versand schlägt fehl (false oder Exception): Vermerk frei, nächster Lauf sendet', async () => {
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    const now = new Date(CHECKOUT + 3 * H);
    sendEmailMock.mockResolvedValueOnce(false);
    expect(await runPowerStayMails(now)).toMatchObject({ sent: 0, failed: 1 });
    expect(mailRows()).toEqual([]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    expect(await runPowerStayMails(now)).toMatchObject({ sent: 0, failed: 1 });
    expect(mailRows()).toEqual([]);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(await runPowerStayMails(now)).toMatchObject({ sent: 1, failed: 0 });
    expect(mailRows()).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
  });

  it('Stichtag fehlt: wird gesetzt, nichts gesendet', async () => {
    db.prepare('DELETE FROM scheduler_state WHERE key = ?').run(POWER_STAY_SINCE_KEY);
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    const now = new Date(CHECKOUT + 3 * H);
    const r = await runPowerStayMails(now);
    expect(r.sent).toBe(0);
    expect(getSchedulerState(POWER_STAY_SINCE_KEY)).toBe(now.toISOString());
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('auffällig: > 1,5 × Median bei ≥ 5 Vergleichsbuchungen → Betreff „auffällig · “', async () => {
    const pairs = [['10-05', '10-07'], ['10-08', '10-10'], ['10-11', '10-13'], ['10-14', '10-16'], ['10-17', '10-19']];
    pairs.forEach(([a, b], i) => insertRes(`c${i}`, `2026-${a}`, `2026-${b}`));
    insertRes('neu', '2026-11-20', '2026-11-22');
    const start = Date.parse('2026-11-20T15:00:00.000Z');
    readings('2026-10-01T00:00:00.000Z', '2026-11-22T12:00:00.000Z', (t) => (t >= start && t < CHECKOUT ? 3 : 1));
    recipient();
    const r = await runPowerStayMails(new Date(CHECKOUT + 3 * H));
    expect(r.sent).toBe(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/^auffällig · Strom Farmhouse Prasser: Gast neu · /);
    expect(mailRows().map((m) => m.reservation_id)).toEqual(['neu']);
  });

  it('Objekt nicht im Reporting: übersprungen', async () => {
    reportingUntilOverride = '2026-01-01';
    insertRes('r1', '2026-11-20', '2026-11-22');
    readings('2026-11-20T00:00:00.000Z', '2026-11-22T12:00:00.000Z');
    recipient();
    await runPowerStayMails(new Date(CHECKOUT + 3 * H));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('wirft nie, auch bei kaputter DB', async () => {
    resetDatabase();
    db.close();
    db = new Database(':memory:');
    setDatabase(db);
    await expect(runPowerStayMails(new Date())).resolves.toBeDefined();
  });
});

describe('selectDuePowerStays (pure)', () => {
  const row = (over: Partial<PowerRow>): PowerRow => ({
    kind: 'stay', reservationId: 'r', guestName: 'G', checkInDate: null, checkOutDate: null,
    startUtc: '2026-11-20T15:00:00.000Z', endUtc: '2026-11-22T10:00:00.000Z', nights: 2, days: 1.8,
    status: 'complete', incompleteReason: null, kwh: 1, kwhPerNight: 1, kwhPerDay: null, deviationPct: null, flagged: false, ...over,
  });
  const rep = (rows: PowerRow[]) => ({ rows } as unknown as PowerReport);
  const since = Date.parse(SINCE);

  it('Leerstand direkt davor (endUtc === startUtc) wird zugeordnet, sonst null', () => {
    const vac = row({ kind: 'vacancy', reservationId: null, startUtc: '2026-11-18T10:00:00.000Z', endUtc: '2026-11-20T15:00:00.000Z' });
    const a = row({ reservationId: 'a' });
    const far = row({ kind: 'vacancy', reservationId: null, startUtc: '2026-11-18T10:00:00.000Z', endUtc: '2026-11-20T14:00:00.000Z' });
    expect(selectDuePowerStays(rep([vac, a]), CHECKOUT + H, since, new Set())[0].vacancyBefore).toBe(vac);
    expect(selectDuePowerStays(rep([far, a]), CHECKOUT + H, since, new Set())[0].vacancyBefore).toBeNull();
    expect(selectDuePowerStays(rep([a]), CHECKOUT + H, since, new Set())[0].vacancyBefore).toBeNull();
  });

  it('Filter: laufend, schon gesendet, Check-out in der Zukunft, vor Stichtag', () => {
    const rows = [
      row({ reservationId: 'run', status: 'running' }),
      row({ reservationId: 'sent' }),
      row({ reservationId: 'future', endUtc: '2026-11-23T10:00:00.000Z' }),
      row({ reservationId: 'old', endUtc: '2026-11-21T10:00:00.000Z' }),
      row({ reservationId: 'ok' }),
      row({ kind: 'vacancy', reservationId: null }),
    ];
    const due = selectDuePowerStays(rep(rows), CHECKOUT + H, since, new Set(['sent']));
    expect(due.map((d) => d.stay.reservationId)).toEqual(['ok']);
  });

  it('unvollständig erst nach 6 h (genau bei Check-out + 6 h fällig)', () => {
    const inc = row({ reservationId: 'i', status: 'incomplete', incompleteReason: 'reset', kwh: null, kwhPerNight: null });
    expect(selectDuePowerStays(rep([inc]), CHECKOUT + POWER_STAY_FALLBACK_MS - 1, since, new Set())).toEqual([]);
    expect(selectDuePowerStays(rep([inc]), CHECKOUT + POWER_STAY_FALLBACK_MS, since, new Set())[0].completeness).toBe('incomplete');
    expect(selectDuePowerStays(rep([row({})]), CHECKOUT, since, new Set())[0].completeness).toBe('complete');
  });
});
