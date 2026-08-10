import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { applyPayout } from './payout-applier.js';
import type { ParsedPayoutMail } from '../../parsers/airbnb-mail/payout.js';

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
  db.prepare(`INSERT INTO reservations
    (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, host_payout, total_price, platform, payout_status)
    VALUES ('HME9WZFQTY','L1','2026-08-02T15:00:00.000Z','2026-08-07T12:00:00.000Z','2026-08-02','2026-08-07',5,'confirmed',425.4,870,'airbnb-mail','estimated')`).run();
});

afterEach(() => { resetDatabase(); db.close(); });

const mail = (messageId: string, items: Array<{ amount: number; stayEnd?: string }>): ParsedPayoutMail => ({
  totalAmount: items.reduce((a, i) => a + i.amount, 0),
  payoutDate: '2026-08-03',
  messageId,
  items: items.map((i) => ({
    amount: i.amount, category: 'Unterkunft',
    stayStart: '2026-08-02', stayEnd: i.stayEnd ?? '2026-08-07',
    listingId: 'L1', reservationCode: 'HME9WZFQTY',
  })),
});

describe('applyPayout', () => {
  it('confirms amount as sum of all payout mails for the code', () => {
    const r1 = applyPayout(mail('m1', [{ amount: 425.4 }]));
    expect(r1.matchedCodes).toEqual(['HME9WZFQTY']);
    const r2 = applyPayout(mail('m2', [{ amount: 72.48, stayEnd: '2026-08-08' }]));
    expect(r2.matchedCodes).toEqual(['HME9WZFQTY']);
    const row = db.prepare(`SELECT host_payout, payout_status, check_out_localized, nights_count FROM reservations WHERE reservation_id='HME9WZFQTY'`).get() as Record<string, unknown>;
    expect(row.host_payout).toBeCloseTo(497.88, 2);
    expect(row.payout_status).toBe('confirmed');
    expect(row.check_out_localized).toBe('2026-08-08'); // date correction from payout item
    expect(row.nights_count).toBe(6);
    expect(r2.dateCorrections).toEqual(['HME9WZFQTY']);
  });

  it('is idempotent when the same mail is applied twice', () => {
    applyPayout(mail('m1', [{ amount: 425.4 }]));
    applyPayout(mail('m1', [{ amount: 425.4 }]));
    const row = db.prepare(`SELECT host_payout FROM reservations WHERE reservation_id='HME9WZFQTY'`).get() as { host_payout: number };
    expect(row.host_payout).toBeCloseTo(425.4, 2);
  });

  it('stores unmatched codes without touching reservations', () => {
    const m: ParsedPayoutMail = {
      totalAmount: 100, payoutDate: '2026-09-18', messageId: 'm9',
      items: [{ amount: 100, category: 'Unterkunft', stayStart: '2026-09-17', stayEnd: '2026-09-22', listingId: 'L1', reservationCode: 'HMRONY00001' }],
    };
    const r = applyPayout(m);
    expect(r.unmatchedCodes).toEqual(['HMRONY00001']);
    expect(db.prepare(`SELECT COUNT(*) c FROM airbnb_payouts WHERE reservation_code='HMRONY00001'`).get()).toEqual({ c: 1 });
  });

  it('groups same-code items in one mail by min(stayStart)/max(stayEnd), not first-wins (review finding #6)', () => {
    // Two line items of the SAME payout mail for the same reservation can
    // carry slightly different stay ranges (e.g. a tax-withholding line vs.
    // the accommodation line after a mid-stay extension). Taking the first
    // item's dates ("first-wins") silently drops a later/earlier item's more
    // accurate range.
    const m: ParsedPayoutMail = {
      totalAmount: 72.48, payoutDate: '2026-08-03', messageId: 'm-range',
      items: [
        { amount: 50, category: 'Unterkunft', stayStart: '2026-08-02', stayEnd: '2026-08-08', listingId: 'L1', reservationCode: 'HME9WZFQTY' },
        { amount: 22.48, category: 'Steuereinbehalt', stayStart: '2026-08-03', stayEnd: '2026-08-10', listingId: 'L1', reservationCode: 'HME9WZFQTY' },
      ],
    };
    const r = applyPayout(m);
    expect(r.dateCorrections).toEqual(['HME9WZFQTY']);
    const row = db.prepare(`SELECT check_in_localized, check_out_localized FROM reservations WHERE reservation_id='HME9WZFQTY'`).get() as Record<string, unknown>;
    expect(row.check_in_localized).toBe('2026-08-02'); // min(2.8., 3.8.)
    expect(row.check_out_localized).toBe('2026-08-10'); // max(8.8., 10.8.)
    const stored = db.prepare(`SELECT stay_start, stay_end FROM airbnb_payouts WHERE reservation_code='HME9WZFQTY'`).get() as Record<string, unknown>;
    expect(stored.stay_start).toBe('2026-08-02');
    expect(stored.stay_end).toBe('2026-08-10');
  });
});
