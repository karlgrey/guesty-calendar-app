import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  insertPayoutItems, getPayoutSumByCode, setReservationPayoutConfirmed,
  setPayoutStatus, updateReservationStay, getEstimatedYearStats, getUnmatchedPayouts,
} from './airbnb-payout-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, host_payout REAL, total_price REAL,
      platform TEXT, payout_status TEXT NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE airbnb_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, listing_id TEXT NOT NULL,
      reservation_code TEXT, payout_date TEXT NOT NULL, amount REAL NOT NULL,
      stay_start TEXT, stay_end TEXT, total_mail_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, reservation_code)
    );
  `);
  setDatabase(db);
});

afterEach(() => { resetDatabase(); db.close(); });

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  message_id: 'm1', listing_id: 'L1', reservation_code: 'HMAAAA0001',
  payout_date: '2026-08-03', amount: 425.4, stay_start: '2026-08-02',
  stay_end: '2026-08-07', total_mail_amount: 425.4, ...over,
});

describe('insertPayoutItems / getPayoutSumByCode', () => {
  it('inserts items and sums per code', () => {
    expect(insertPayoutItems([item()])).toBe(1);
    expect(insertPayoutItems([item({ message_id: 'm2', amount: 72.48 })])).toBe(1);
    const { sum, count } = getPayoutSumByCode('HMAAAA0001');
    expect(sum).toBeCloseTo(497.88, 2);
    expect(count).toBe(2);
  });

  it('is idempotent on (message_id, reservation_code)', () => {
    insertPayoutItems([item()]);
    expect(insertPayoutItems([item({ amount: 999 })])).toBe(0);
    expect(getPayoutSumByCode('HMAAAA0001').sum).toBeCloseTo(425.4, 2);
  });
});

describe('reservation updates', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO reservations
      (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, host_payout, total_price, platform, payout_status)
      VALUES ('HMAAAA0001','L1','2026-08-02T15:00:00.000Z','2026-08-07T12:00:00.000Z','2026-08-02','2026-08-07',5,'confirmed',425.4,870,'airbnb-mail','estimated')`).run();
  });

  it('setReservationPayoutConfirmed writes amount + confirmed', () => {
    setReservationPayoutConfirmed('HMAAAA0001', 497.88);
    const row = db.prepare(`SELECT host_payout, payout_status FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as { host_payout: number; payout_status: string };
    expect(row.host_payout).toBeCloseTo(497.88, 2);
    expect(row.payout_status).toBe('confirmed');
  });

  it('setPayoutStatus flips only the flag', () => {
    setPayoutStatus('HMAAAA0001', 'confirmed');
    const row = db.prepare(`SELECT host_payout, payout_status FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as { host_payout: number; payout_status: string };
    expect(row.payout_status).toBe('confirmed');
    expect(row.host_payout).toBeCloseTo(425.4, 2);
  });

  it('updateReservationStay keeps the time-of-day and recomputes nights', () => {
    updateReservationStay('HMAAAA0001', '2026-08-02', '2026-08-08');
    const row = db.prepare(`SELECT check_in, check_out, check_in_localized, check_out_localized, nights_count FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as Record<string, unknown>;
    expect(row.check_in).toBe('2026-08-02T15:00:00.000Z');
    expect(row.check_out).toBe('2026-08-08T12:00:00.000Z');
    expect(row.check_out_localized).toBe('2026-08-08');
    expect(row.nights_count).toBe(6);
  });
});

describe('report queries', () => {
  it('getEstimatedYearStats counts only estimated rows of the listing/year', () => {
    const ins = db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, nights_count, host_payout, total_price, payout_status) VALUES (?,?,?,?,?,?,?)`);
    ins.run('HMB1', 'L1', '2026-12-26T15:00:00.000Z', 4, 512.38, 1068, 'estimated');
    ins.run('HMB2', 'L1', '2026-07-01T15:00:00.000Z', 3, 300, 400, 'confirmed');
    ins.run('HMB3', 'L2', '2026-07-01T15:00:00.000Z', 3, 300, 400, 'estimated');
    ins.run('HMB4', 'L1', '2025-07-01T15:00:00.000Z', 3, 300, 400, 'estimated');
    const stats = getEstimatedYearStats('L1', 2026);
    expect(stats.count).toBe(1);
    expect(stats.revenue).toBeCloseTo(512.38, 2);
  });

  it('getUnmatchedPayouts returns payouts without a matching reservation', () => {
    insertPayoutItems([item({ reservation_code: 'HMNOMATCH1' })]);
    const rows = getUnmatchedPayouts('L1');
    expect(rows).toHaveLength(1);
    expect(rows[0].reservation_code).toBe('HMNOMATCH1');
  });
});
