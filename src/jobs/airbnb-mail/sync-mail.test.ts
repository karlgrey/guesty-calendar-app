// src/jobs/airbnb-mail/sync-mail.test.ts
//
// Bug (#324, Florence weekly-summary undercount): a single mail whose
// processing throws (e.g. an insertMail/DB failure, or any unexpected error
// outside the existing per-parse try/catch) propagated out of the whole
// `for` loop. `setLastUid()` is only called AFTER the loop finishes, so that
// throw meant the batch's UID progress was silently discarded. The next sync
// run re-fetched the exact same batch starting at the same UID, hit the same
// failure again, and the property's mail ingest got permanently wedged —
// this is what happened in production: Florence's airbnb-mail sync silently
// stopped advancing for >2 months, so bookings confirmed after the freeze
// (John Charlton onward) never made it into `reservations`, undercounting
// the weekly-summary email.
//
// Fix: scope failures to a single mail. One bad message must not block the
// rest of the batch, and the UID must still advance past it so future runs
// don't get stuck retrying forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import type { PropertyConfig } from '../../config/properties.js';

vi.mock('../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      airbnbMailHost: 'imap.example.com',
      airbnbMailPort: 993,
      airbnbMailUser: 'bot@example.com',
      airbnbMailPassword: 'secret',
    },
  };
});

const fetchNewMailsMock = vi.fn();
const connectMock = vi.fn();
const disconnectMock = vi.fn();
vi.mock('../../services/airbnb-mail/imap-client.js', () => ({
  AirbnbImapClient: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    fetchNewMails: fetchNewMailsMock,
    disconnect: disconnectMock,
  })),
}));

const insertMailMock = vi.fn();
const updateParseStatusMock = vi.fn();
const getLastUidMock = vi.fn();
const setLastUidMock = vi.fn();
const pruneOldMailsMock = vi.fn().mockReturnValue(0);
vi.mock('../../repositories/airbnb-mail-archive-repository.js', () => ({
  insertMail: (...args: unknown[]) => insertMailMock(...args),
  updateParseStatus: (...args: unknown[]) => updateParseStatusMock(...args),
  getLastUid: (...args: unknown[]) => getLastUidMock(...args),
  setLastUid: (...args: unknown[]) => setLastUidMock(...args),
  pruneOldMails: (...args: unknown[]) => pruneOldMailsMock(...args),
}));

import { syncAirbnbMail } from './sync-mail.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id TEXT NOT NULL UNIQUE,
      listing_id TEXT NOT NULL,
      status TEXT NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      guest_name TEXT,
      guests_count INTEGER,
      source TEXT,
      created_at_guesty TEXT,
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
      internal_guest_id TEXT,
      guest_company TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  vi.clearAllMocks();
  pruneOldMailsMock.mockReturnValue(0);
  getLastUidMock.mockReturnValue(10);
});

afterEach(() => {
  resetDatabase();
  db.close();
});

const property: PropertyConfig = {
  slug: 'firenze-loft',
  provider: 'airbnb-mail',
  airbnbListingId: 'listing-firenze',
  airbnbIcalUrl: 'https://example.com/cal.ics',
  airbnbMailLabel: 'AirBnB Firenze',
  name: 'Urban Luxury Loft - Florence',
  timezone: 'Europe/Rome',
  currency: 'EUR',
  bookingRecipientEmail: 'firenze@example.com',
  bookingSenderName: 'Florence',
  weeklyReport: { enabled: true, recipients: [], day: 1, hour: 6 },
} as unknown as PropertyConfig;

// Fixture shaped after a real Airbnb confirmed-booking mail body (see
// confirmed-booking.test.ts) — parseable by parseConfirmedBooking.
function confirmedMail(uid: number, code: string, name: string, day: string, month: string) {
  return {
    uid,
    messageId: `msg-${uid}@airbnb.com`,
    subject: `Buchung bestätigt – ${name} kommt am ${day}. ${month} an`,
    fromAddress: 'automated@airbnb.com',
    receivedAt: '2026-07-01T09:00:00.000Z',
    htmlBody: '',
    textBody:
      `Neue Buchung bestätigt: ${name} kommt am ${day}. ${month} an` +
      ` ${name} Identität verifiziert · 8 Bewertungen` +
      ' Urban Luxury Loft - Florence Interior Design Hub Gesamte Unterkunft' +
      ` Check-in Mo., ${day}. ${month} 15:00 Check-out Fr., ${Number(day) + 3}. ${month} 10:00` +
      ' Gäste 1 Erwachsene:r' +
      ` Bestätigungs-Code ${code}` +
      ' 100,00 € x 3 Nächte 300,00 € Reinigungsgebühr 50,00 €' +
      ' Servicegebühr für Gäste 0,00 € Belegungssteuern 10,00 €' +
      ' Gesamt (EUR) 360,00 €' +
      ' Auszahlung an Gastgeber:in Gebühr für 3 Nächte 300,00 €' +
      ' Reinigungsgebühr 50,00 € Servicegebühr für Gastgeber:innen (15.5 % + MwSt.) -55,00 €' +
      ' Du verdienst 295,00 €',
  };
}

describe('syncAirbnbMail — per-mail resilience', () => {
  it('one mail failing to archive does not block earlier/later mails in the batch, and UID still advances', async () => {
    const mails = [
      confirmedMail(11, 'HMAAA11111', 'Anna Erste', '10', 'Juli'),
      confirmedMail(12, 'HMBBB22222', 'Boris Zweite', '15', 'Juli'),
      confirmedMail(13, 'HMCCC33333', 'Clara Dritte', '20', 'Juli'),
    ];
    fetchNewMailsMock.mockResolvedValue(mails);

    // Simulate a DB/archive failure specifically for the 2nd mail — this used
    // to throw out of the whole loop (insertMail() sat outside any try/catch).
    insertMailMock.mockImplementation((row: { message_id: string }) => {
      if (row.message_id === 'msg-12@airbnb.com') {
        throw new Error('simulated DB failure archiving mail 12');
      }
    });

    const result = await syncAirbnbMail(property);

    expect(result.success).toBe(true);

    // Mail 1 and mail 3 must still be persisted as reservations...
    const codes = db
      .prepare('SELECT confirmation_code FROM reservations ORDER BY confirmation_code')
      .all() as { confirmation_code: string }[];
    expect(codes.map((c) => c.confirmation_code)).toEqual(['HMAAA11111', 'HMCCC33333']);

    // ...mail 2 is skipped, not silently retried as if it never happened.
    expect(result.parsedError).toBeGreaterThanOrEqual(1);

    // Crucially: UID progress must still reach the batch max (13), even
    // though mail 12 failed — otherwise the next run refetches the same
    // batch, hits the same failure again, and the property is wedged forever.
    expect(setLastUidMock).toHaveBeenCalledWith('firenze-loft', 13);
  });
});

describe('syncAirbnbMail — staleness signal (#327)', () => {
  it('still refreshes last_sync_at (via setLastUid) on a successful poll with zero new mails', async () => {
    // A quiet mailbox (no new bookings) is a SUCCESSFUL sync, not a broken
    // one. If setLastUid() only ran when the UID advanced, last_sync_at would
    // go stale during any quiet period and the #327 alarm would false-fire.
    fetchNewMailsMock.mockResolvedValue([]);

    const result = await syncAirbnbMail(property);

    expect(result.success).toBe(true);
    expect(result.fetched).toBe(0);
    expect(setLastUidMock).toHaveBeenCalledWith('firenze-loft', 10); // lastUid unchanged, but still called
  });

  it('does not touch last_sync_at when the IMAP connection itself fails', async () => {
    connectMock.mockRejectedValueOnce(new Error('IMAP login failed'));

    const result = await syncAirbnbMail(property);

    expect(result.success).toBe(false);
    expect(setLastUidMock).not.toHaveBeenCalled();
  });
});

function payoutMail(uid: number, totalEur: string, bodyText: string) {
  return {
    uid,
    messageId: `payout-${uid}@airbnb.com`,
    subject: `Wir haben eine Auszahlung in Höhe von ${totalEur} € EUR gesendet`,
    fromAddress: 'express@airbnb.com',
    receivedAt: '2026-08-03T13:52:27.000Z',
    htmlBody: '',
    textBody: bodyText,
  };
}

describe('syncAirbnbMail — payout_status on ingest (review finding #1)', () => {
  it('marks a newly confirmed booking as payout_status=estimated (no payout mail seen yet)', async () => {
    // Migration 022's DEFAULT 'confirmed' only covers pre-existing rows —
    // upsertReservation doesn't know the column, so every NEW confirmed
    // booking must be explicitly flipped to 'estimated' here.
    fetchNewMailsMock.mockResolvedValue([confirmedMail(20, 'HMNEWCODE1', 'Nina Neu', '5', 'August')]);

    const result = await syncAirbnbMail(property);

    expect(result.confirmedCount).toBe(1);
    const row = db
      .prepare(`SELECT payout_status FROM reservations WHERE confirmation_code = 'HMNEWCODE1'`)
      .get() as { payout_status: string };
    expect(row.payout_status).toBe('estimated');
  });
});

describe('syncAirbnbMail — payout mail with 0 line items (review finding #3)', () => {
  it('marks the mail as a parse error, not ok, when the payout parser finds 0 line items', async () => {
    fetchNewMailsMock.mockResolvedValue([payoutMail(21, '72,48', 'no parseable line items in this body at all')]);

    const result = await syncAirbnbMail(property);

    expect(result.parsedError).toBeGreaterThanOrEqual(1);
    expect(updateParseStatusMock).toHaveBeenCalledWith(
      'payout-21@airbnb.com',
      'error',
      expect.stringContaining('0 line items'),
      null,
      'payout'
    );
  });
});
