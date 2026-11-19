// src/jobs/sync-inquiries.test.ts
//
// Bug #271 (Fall Kemkes): syncInquiries holte nur die ersten 100 Reservierungen
// ohne Paginierung — bei Listings mit >100 historischen Reservierungen kamen
// neue Buchungen/Stornos nie in der inquiries-Tabelle an, wodurch
// getCancelledReservationIds Stornos nie sah und Google-Kalender-Events
// als Geister stehen blieben.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getReservations: vi.fn() },
}));

import { guestyClient } from '../services/guesty-client.js';
import { syncInquiries, mapGuestyInquiryMoney, upsertGuestyInquiries } from './sync-inquiries.js';

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
      currency TEXT,
      total_price REAL,
      host_payout REAL,
      guest_total REAL,
      price_basis TEXT,
      created_at_guesty TEXT,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);
  vi.resetAllMocks();
});
afterEach(() => { resetDatabase(); db.close(); });

function fakeReservation(i: number, status = 'confirmed') {
  return {
    _id: `res-${String(i).padStart(4, '0')}`,
    listingId: 'listing-fh',
    status,
    checkIn: '2026-09-01T08:00:00Z',
    checkOut: '2026-09-03T12:00:00Z',
    checkInDateLocalized: '2026-09-01',
    checkOutDateLocalized: '2026-09-03',
    guest: { fullName: `Gast ${i}` },
    guestsCount: 2,
    source: 'manual',
    createdAt: '2026-07-01T00:00:00Z',
  };
}

describe('syncInquiries Paginierung (#271)', () => {
  it('holt ALLE Seiten und upsertet auch Reservierungen jenseits der ersten 100', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fakeReservation(i));
    // Kemkes-Fall: der Storno steckt auf Seite 2
    const page2 = [...Array.from({ length: 20 }, (_, i) => fakeReservation(100 + i)),
      { ...fakeReservation(120), _id: 'res-kemkes', status: 'canceled', guest: { fullName: 'Tobias Kemkes' } }];
    (guestyClient.getReservations as any)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const result = await syncInquiries('listing-fh');

    expect(result.success).toBe(true);
    // Seite 2 wurde mit skip=100 angefordert
    const calls = (guestyClient.getReservations as any).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toMatchObject({ listingId: 'listing-fh', skip: 100 });

    const count = db.prepare('SELECT COUNT(*) n FROM inquiries').get() as { n: number };
    expect(count.n).toBe(121);
    const kemkes = db.prepare('SELECT status FROM inquiries WHERE inquiry_id = ?').get('res-kemkes') as { status: string };
    expect(kemkes.status).toBe('canceled');
  });

  it('einzelne Seite (<100): keine zweite Anfrage', async () => {
    (guestyClient.getReservations as any).mockResolvedValueOnce([fakeReservation(1), fakeReservation(2)]);
    const result = await syncInquiries('listing-fh');
    expect(result.success).toBe(true);
    expect((guestyClient.getReservations as any).mock.calls.length).toBe(1);
    const count = db.prepare('SELECT COUNT(*) n FROM inquiries').get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('Preisdaten an Anfragen (#1187)', () => {
  const money = { currency: 'EUR', hostPayout: 1234, fareAccommodationAdjusted: 1450 };
  const row = () => db.prepare('SELECT currency, total_price, host_payout FROM inquiries WHERE inquiry_id = ?').get('res-0001') as any;

  it('Anfrage mit money: Zeile trägt Währung, Gastpreis und Auszahlung', async () => {
    (guestyClient.getReservations as any).mockResolvedValueOnce([{ ...fakeReservation(1, 'inquiry'), money }]);
    await syncInquiries('listing-fh');
    expect(row()).toEqual({ currency: 'EUR', total_price: 1450, host_payout: 1234 });
  });

  it('ohne money: NULLs', async () => {
    (guestyClient.getReservations as any).mockResolvedValueOnce([fakeReservation(1, 'inquiry')]);
    await syncInquiries('listing-fh');
    expect(row()).toEqual({ currency: null, total_price: null, host_payout: null });
  });

  it('zweiter Sync ohne money überschreibt bekannte Werte nicht', async () => {
    (guestyClient.getReservations as any)
      .mockResolvedValueOnce([{ ...fakeReservation(1, 'inquiry'), money }])
      .mockResolvedValueOnce([fakeReservation(1, 'inquiry')]);
    await syncInquiries('listing-fh');
    await syncInquiries('listing-fh');
    expect(row()).toEqual({ currency: 'EUR', total_price: 1450, host_payout: 1234 });
  });

  it('mapGuestyInquiryMoney: Mapping, 0 bleibt 0, Unbrauchbares wird null', () => {
    expect(mapGuestyInquiryMoney({ money })).toEqual({ currency: 'EUR', total_price: 1450, host_payout: 1234 });
    expect(mapGuestyInquiryMoney({ money: { currency: 'EUR', hostPayout: 0, fareAccommodationAdjusted: 0 } }))
      .toEqual({ currency: 'EUR', total_price: 0, host_payout: 0 });
    expect(mapGuestyInquiryMoney({})).toEqual({ currency: null, total_price: null, host_payout: null });
    expect(mapGuestyInquiryMoney({ money: { currency: '', hostPayout: '12', fareAccommodationAdjusted: NaN } }))
      .toEqual({ currency: null, total_price: null, host_payout: null });
  });
});

describe('Gast-Gesamtbetrag an Anfragen (#1242)', () => {
  // Fall Daniel, Werte vom echten Payload (19.11.2026): Airbnb-Anfrage nur mit Netto-Position
  const danielListMoney = {
    currency: 'EUR', hostPayout: 3118.05, fareAccommodationAdjusted: 3118.05,
    fareCleaning: 0, totalTaxes: 0, hostServiceFee: 0,
  };
  // Einzelabruf GET /reservations/{id} liefert den ganzen money-Block (mehr Felder als die Liste)
  const danielFullMoney = {
    ...danielListMoney, fareAccommodation: 3118.05, subTotalPrice: 3118.05, commissionFormula: 'net_income',
    invoiceItems: [{ normalType: 'AF', amount: 3118.05, origin: 'CHANNEL' }],
  };
  const daniel = (money: Record<string, unknown>, status = 'inquiry') =>
    ({ ...fakeReservation(1, status), _id: 'daniel', source: 'airbnb2', guestsCount: 8, money });
  const row = (id = 'daniel') =>
    db.prepare('SELECT total_price, host_payout, guest_total, price_basis FROM inquiries WHERE inquiry_id = ?').get(id) as any;

  it('Stunden-Sync (Liste) und Einzelabruf schreiben denselben Wert (gemeinsamer Mapper)', async () => {
    (guestyClient.getReservations as any).mockResolvedValueOnce([daniel(danielListMoney)]);
    await syncInquiries('listing-fh');
    const fromList = row();

    db.exec('DELETE FROM inquiries');
    expect(upsertGuestyInquiries([daniel(danielFullMoney)])).toBe(1); // Weg des Einzelabrufs (inquiry-prefetch realDeps)
    const fromSingle = row();

    expect(fromList).toEqual({ total_price: 3118.05, host_payout: 3118.05, guest_total: null, price_basis: 'net_payout' });
    expect(fromSingle).toEqual(fromList);
  });

  it('Anfrage wird Buchung: net_payout → echter Gastbetrag', async () => {
    const confirmedMoney = {
      currency: 'EUR', hostPayout: 3339.75, fareAccommodationAdjusted: 3300,
      fareCleaning: 350, totalTaxes: 255.5, hostServiceFee: 565.75,
    };
    (guestyClient.getReservations as any)
      .mockResolvedValueOnce([daniel(danielListMoney)])
      .mockResolvedValueOnce([daniel(confirmedMoney, 'confirmed')]);
    await syncInquiries('listing-fh');
    await syncInquiries('listing-fh');
    expect(row()).toMatchObject({ guest_total: 3905.5, price_basis: 'guest_total' });
  });

  it('Payload ohne Aufschlüsselung überschreibt bekannten Gastbetrag nicht', async () => {
    (guestyClient.getReservations as any)
      .mockResolvedValueOnce([daniel({ ...danielListMoney, hostPayout: 163.78, fareAccommodationAdjusted: 139, fareCleaning: 40, totalTaxes: 12.53, hostServiceFee: 27.75 }, 'confirmed')])
      .mockResolvedValueOnce([daniel({ currency: 'EUR', hostPayout: 163.78, fareAccommodationAdjusted: 139 }, 'confirmed')]);
    await syncInquiries('listing-fh');
    await syncInquiries('listing-fh');
    expect(row()).toMatchObject({ guest_total: 191.53, price_basis: 'guest_total' });
  });
});
