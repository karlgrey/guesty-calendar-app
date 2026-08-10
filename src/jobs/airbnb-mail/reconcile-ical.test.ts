import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import {
  reconcileAirbnbReservations,
  findReservationsMissingInIcal,
  groupBookedIntervals,
} from './reconcile-ical.js';
import type { PropertyConfig } from '../../config/properties.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      nickname TEXT,
      accommodates INTEGER NOT NULL,
      bedrooms INTEGER,
      bathrooms REAL,
      property_type TEXT,
      timezone TEXT NOT NULL,
      currency TEXT NOT NULL,
      base_price REAL NOT NULL,
      weekend_base_price REAL,
      cleaning_fee REAL NOT NULL DEFAULT 0,
      extra_person_fee REAL NOT NULL DEFAULT 0,
      guests_included INTEGER NOT NULL DEFAULT 1,
      weekly_price_factor REAL DEFAULT 1.0,
      monthly_price_factor REAL DEFAULT 1.0,
      taxes TEXT NOT NULL DEFAULT '[]',
      min_nights INTEGER NOT NULL DEFAULT 1,
      max_nights INTEGER,
      check_in_time TEXT,
      check_out_time TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      price REAL NOT NULL,
      min_nights INTEGER NOT NULL DEFAULT 1,
      closed_to_arrival INTEGER DEFAULT 0,
      closed_to_departure INTEGER DEFAULT 0,
      block_type TEXT,
      block_ref TEXT,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id TEXT NOT NULL UNIQUE,
      listing_id TEXT NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      check_in_localized TEXT,
      check_out_localized TEXT,
      nights_count INTEGER NOT NULL,
      guest_id TEXT,
      guest_name TEXT,
      guests_count INTEGER,
      adults_count INTEGER,
      children_count INTEGER,
      infants_count INTEGER,
      status TEXT NOT NULL,
      confirmation_code TEXT,
      source TEXT,
      platform TEXT,
      planned_arrival TEXT,
      planned_departure TEXT,
      currency TEXT,
      total_price REAL,
      host_payout REAL,
      balance_due REAL,
      total_paid REAL,
      created_at_guesty TEXT,
      reserved_at TEXT,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      internal_guest_id TEXT,
      guest_company TEXT,
      payout_status TEXT NOT NULL DEFAULT 'confirmed'
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

const prop: PropertyConfig = {
  slug: 'firenze-loft',
  provider: 'airbnb-mail',
  airbnbListingId: 'L1',
  airbnbIcalUrl: 'https://example.com/cal.ics',
  name: 'Urban Luxury Loft - Florence',
  timezone: 'Europe/Rome',
  currency: 'EUR',
  bookingRecipientEmail: 'x@example.com',
  bookingSenderName: 'Test',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 9 },
  static: { accommodates: 4, cleaningFee: 130, coHostShareRate: 0.15, incomeTaxRate: 0.21 },
};

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function insertAvailability(listingId: string, start: string, endExclusive: string, blockRef: string): void {
  const stmt = db.prepare(`
    INSERT INTO availability (listing_id, date, status, price, min_nights, block_type, block_ref, last_synced_at)
    VALUES (?, ?, 'booked', 100, 1, 'reservation', ?, datetime('now'))
  `);
  let day = start;
  while (day < endExclusive) {
    stmt.run(listingId, day, blockRef);
    day = addOneDay(day);
  }
}

function insertReservation(over: Partial<Record<string, unknown>> = {}): void {
  const base = {
    reservation_id: 'HMAAAA0001', listing_id: 'L1',
    check_in: '2026-08-02T15:00:00.000Z', check_out: '2026-08-07T12:00:00.000Z',
    check_in_localized: '2026-08-02', check_out_localized: '2026-08-07',
    nights_count: 5, status: 'confirmed', host_payout: 425.4, total_price: 870,
    platform: 'airbnb-mail', payout_status: 'estimated', last_synced_at: new Date().toISOString(),
    ...over,
  };
  db.prepare(`
    INSERT INTO reservations
      (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized,
       nights_count, status, host_payout, total_price, platform, payout_status, last_synced_at)
    VALUES
      (@reservation_id, @listing_id, @check_in, @check_out, @check_in_localized, @check_out_localized,
       @nights_count, @status, @host_payout, @total_price, @platform, @payout_status, @last_synced_at)
  `).run(base);
}

function insertListing(id: string, basePrice: number): void {
  db.prepare(`
    INSERT INTO listings (id, title, accommodates, timezone, currency, base_price, last_synced_at)
    VALUES (?, 'Test Listing', 4, 'Europe/Rome', 'EUR', ?, datetime('now'))
  `).run(id, basePrice);
}

describe('groupBookedIntervals', () => {
  it('groups consecutive days with the same block_ref into one interval, breaking on gaps or ref changes', () => {
    const rows = [
      { date: '2026-08-01', block_ref: 'HMA' },
      { date: '2026-08-02', block_ref: 'HMA' },
      { date: '2026-08-03', block_ref: 'HMB' },
      { date: '2026-08-05', block_ref: 'HMB' }, // gap -> new interval despite same ref
    ];
    expect(groupBookedIntervals(rows)).toEqual([
      { code: 'HMA', start: '2026-08-01', endExclusive: '2026-08-03' },
      { code: 'HMB', start: '2026-08-03', endExclusive: '2026-08-04' },
      { code: 'HMB', start: '2026-08-05', endExclusive: '2026-08-06' },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(groupBookedIntervals([])).toEqual([]);
  });
});

describe('reconcileAirbnbReservations', () => {
  it('corrects dates when the iCal block moved (Puneet case)', () => {
    insertReservation({
      reservation_id: 'HMZ82HRR38', check_in: '2026-12-26T15:00:00.000Z', check_out: '2026-12-30T12:00:00.000Z',
      check_in_localized: '2026-12-26', check_out_localized: '2026-12-30', nights_count: 4, host_payout: 512.38,
      payout_status: 'estimated',
    });
    insertAvailability('L1', '2026-12-27', '2027-01-03', 'HMZ82HRR38');

    const res = reconcileAirbnbReservations(prop, '2026-08-10');
    expect(res.updated).toEqual(['HMZ82HRR38']);

    const row = db.prepare(`
      SELECT check_in_localized, check_out_localized, nights_count, host_payout, payout_status
      FROM reservations WHERE reservation_id = 'HMZ82HRR38'
    `).get() as Record<string, unknown>;
    expect(row.check_in_localized).toBe('2026-12-27');
    expect(row.check_out_localized).toBe('2027-01-03');
    expect(row.nights_count).toBe(7);
    expect(row.host_payout).toBeCloseTo(896.67, 2);
    expect(row.payout_status).toBe('estimated');
  });

  it('does not move check_in of an in-progress stay (past days pruned)', () => {
    insertReservation({
      reservation_id: 'HMINPROG01', check_in: '2026-08-09T15:00:00.000Z', check_out: '2026-08-15T12:00:00.000Z',
      check_in_localized: '2026-08-09', check_out_localized: '2026-08-15', nights_count: 6,
    });
    insertAvailability('L1', '2026-08-10', '2026-08-15', 'HMINPROG01');

    const res = reconcileAirbnbReservations(prop, '2026-08-10');
    expect(res.updated).toEqual([]);

    const row = db.prepare(`
      SELECT check_in_localized, check_out_localized FROM reservations WHERE reservation_id = 'HMINPROG01'
    `).get() as Record<string, unknown>;
    expect(row.check_in_localized).toBe('2026-08-09'); // untouched
    expect(row.check_out_localized).toBe('2026-08-15'); // matched already
  });

  it('creates a placeholder for an iCal-only booking (Rony case) and marks it estimated', () => {
    insertListing('L1', 250);
    insertAvailability('L1', '2026-09-17', '2026-09-22', 'HMRONY00001');

    const res = reconcileAirbnbReservations(prop, '2026-08-10');
    expect(res.created).toEqual(['HMRONY00001']);

    const row = db.prepare(`
      SELECT guest_name, check_in_localized, check_out_localized, nights_count, platform,
             payout_status, total_price, host_payout
      FROM reservations WHERE reservation_id = 'HMRONY00001'
    `).get() as Record<string, unknown>;
    expect(row.guest_name).toBe('Airbnb-Gast (aus Kalender)');
    expect(row.check_in_localized).toBe('2026-09-17');
    expect(row.check_out_localized).toBe('2026-09-22');
    expect(row.nights_count).toBe(5);
    expect(row.platform).toBe('airbnb-ical');
    expect(row.payout_status).toBe('estimated');
    expect(row.total_price).toBeCloseTo(1380, 2);
    expect(row.host_payout).toBeCloseTo(902.7, 2);
  });

  it('adopts stored payouts when creating a placeholder', () => {
    insertListing('L1', 250);
    insertAvailability('L1', '2026-09-17', '2026-09-22', 'HMRONY00001');
    db.prepare(`
      INSERT INTO airbnb_payouts (message_id, listing_id, reservation_code, payout_date, amount, stay_start, stay_end, total_mail_amount)
      VALUES ('m1', 'L1', 'HMRONY00001', '2026-09-23', 100, '2026-09-17', '2026-09-22', 100)
    `).run();

    const res = reconcileAirbnbReservations(prop, '2026-08-10');
    expect(res.created).toEqual(['HMRONY00001']);

    const row = db.prepare(`
      SELECT payout_status, host_payout FROM reservations WHERE reservation_id = 'HMRONY00001'
    `).get() as Record<string, unknown>;
    expect(row.payout_status).toBe('confirmed');
    expect(row.host_payout).toBeCloseTo(100, 2);
  });

  it('reports future mail-reservations missing from the calendar', () => {
    insertReservation({
      reservation_id: 'HMGONE00001', check_in: '2026-10-01T15:00:00.000Z', check_out: '2026-10-05T12:00:00.000Z',
      check_in_localized: '2026-10-01', check_out_localized: '2026-10-05', nights_count: 4,
    });
    // No availability block for HMGONE00001 at all.

    const res = reconcileAirbnbReservations(prop, '2026-08-10');
    expect(res.missingInIcal).toEqual(['HMGONE00001']);
  });
});

describe('findReservationsMissingInIcal', () => {
  it('returns confirmed future mail/ical reservations absent from the calendar', () => {
    insertReservation({
      reservation_id: 'HMGONE00002', check_in: '2026-11-01T15:00:00.000Z',
      check_in_localized: '2026-11-01', check_out_localized: '2026-11-05',
    });
    expect(findReservationsMissingInIcal('L1', '2026-08-10')).toEqual(['HMGONE00002']);
  });

  it('excludes reservations that still have a matching availability block', () => {
    insertReservation({
      reservation_id: 'HMPRESENT01', check_in: '2026-11-01T15:00:00.000Z',
      check_in_localized: '2026-11-01', check_out_localized: '2026-11-05',
    });
    insertAvailability('L1', '2026-11-01', '2026-11-05', 'HMPRESENT01');
    expect(findReservationsMissingInIcal('L1', '2026-08-10')).toEqual([]);
  });
});
