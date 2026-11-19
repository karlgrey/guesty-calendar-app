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
  // #1099: Liste über getReservationsPage (v3 search), money/Gast über by-ids/guests-crud
  guestyClient: { getReservationsPage: vi.fn(), getReservationsV3ByIds: vi.fn(), getGuest: vi.fn() },
}));

import { guestyClient } from '../services/guesty-client.js';
import {
  syncInquiries, mapGuestyInquiryMoney, upsertGuestyInquiries,
  enrichGuestyListReservations, resetGuestNameCacheForTests, MAX_GUEST_FETCHES_PER_RUN,
  type LocalInquiryState,
} from './sync-inquiries.js';

const page = (results: any[], hasMore = false) => ({ results, hasMore });
const listMock = () => guestyClient.getReservationsPage as any;

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
  resetGuestNameCacheForTests();
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
    listMock()
      .mockResolvedValueOnce(page(page1, true))
      .mockResolvedValueOnce(page(page2));

    const result = await syncInquiries('listing-fh');

    expect(result.success).toBe(true);
    // Seite 2 wurde mit skip=100 angefordert
    const calls = listMock().mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toMatchObject({ listingId: 'listing-fh', skip: 100 });

    const count = db.prepare('SELECT COUNT(*) n FROM inquiries').get() as { n: number };
    expect(count.n).toBe(121);
    const kemkes = db.prepare('SELECT status FROM inquiries WHERE inquiry_id = ?').get('res-kemkes') as { status: string };
    expect(kemkes.status).toBe('canceled');
  });

  it('hasMore=false: keine zweite Anfrage', async () => {
    listMock().mockResolvedValueOnce(page([fakeReservation(1), fakeReservation(2)]));
    const result = await syncInquiries('listing-fh');
    expect(result.success).toBe(true);
    expect(listMock().mock.calls.length).toBe(1);
    const count = db.prepare('SELECT COUNT(*) n FROM inquiries').get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('Preisdaten an Anfragen (#1187)', () => {
  const money = { currency: 'EUR', hostPayout: 1234, fareAccommodationAdjusted: 1450 };
  const row = () => db.prepare('SELECT currency, total_price, host_payout FROM inquiries WHERE inquiry_id = ?').get('res-0001') as any;

  it('Anfrage mit money: Zeile trägt Währung, Gastpreis und Auszahlung', async () => {
    listMock().mockResolvedValueOnce(page([{ ...fakeReservation(1, 'inquiry'), money }]));
    await syncInquiries('listing-fh');
    expect(row()).toEqual({ currency: 'EUR', total_price: 1450, host_payout: 1234 });
  });

  it('ohne money: NULLs', async () => {
    listMock().mockResolvedValueOnce(page([fakeReservation(1, 'inquiry')]));
    await syncInquiries('listing-fh');
    expect(row()).toEqual({ currency: null, total_price: null, host_payout: null });
  });

  it('zweiter Sync ohne money überschreibt bekannte Werte nicht', async () => {
    listMock()
      .mockResolvedValueOnce(page([{ ...fakeReservation(1, 'inquiry'), money }]))
      .mockResolvedValueOnce(page([fakeReservation(1, 'inquiry')]));
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
    listMock().mockResolvedValueOnce(page([daniel(danielListMoney)]));
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
    listMock()
      .mockResolvedValueOnce(page([daniel(danielListMoney)]))
      .mockResolvedValueOnce(page([daniel(confirmedMoney, 'confirmed')]));
    await syncInquiries('listing-fh');
    await syncInquiries('listing-fh');
    expect(row()).toMatchObject({ guest_total: 3905.5, price_basis: 'guest_total' });
  });

  it('Payload ohne Aufschlüsselung überschreibt bekannten Gastbetrag nicht', async () => {
    listMock()
      .mockResolvedValueOnce(page([daniel({ ...danielListMoney, hostPayout: 163.78, fareAccommodationAdjusted: 139, fareCleaning: 40, totalTaxes: 12.53, hostServiceFee: 27.75 }, 'confirmed')]))
      .mockResolvedValueOnce(page([daniel({ currency: 'EUR', hostPayout: 163.78, fareAccommodationAdjusted: 139 }, 'confirmed')]));
    await syncInquiries('listing-fh');
    await syncInquiries('listing-fh');
    expect(row()).toMatchObject({ guest_total: 191.53, price_basis: 'guest_total' });
  });
});

describe('#1099 sparsames Nachladen (enrichGuestyListReservations)', () => {
  const today = '2026-11-19';
  // Listenform aus v3 search: ohne money, ohne guest, mit guestId
  const listItem = (id: string, status: string, checkOut: string, guestId = `g-${id}`) => ({
    _id: id, listingId: 'listing-fh', status, checkIn: '2026-01-01', checkOut,
    checkInDateLocalized: '2026-01-01', checkOutDateLocalized: checkOut, guestsCount: 2, source: 'manual', guestId,
  });
  const deps = () => ({
    getReservationsV3ByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ _id: id, money: { currency: 'EUR', hostPayout: 1, fareAccommodationAdjusted: 1 } }))),
    getGuest: vi.fn(async (gid: string) => ({ fullName: `Name ${gid}` })),
  });

  it('nichts nachladen bei bekannter Zeile, gleichem Status und vergangenem Aufenthalt', async () => {
    const r = [listItem('a', 'confirmed', '2026-03-01')];
    const local = new Map<string, LocalInquiryState>([['a', { status: 'confirmed', guest_name: 'Alt Bekannt' }]]);
    const d = deps();
    const stats = await enrichGuestyListReservations(r, local, d, { today });
    expect(d.getReservationsV3ByIds).not.toHaveBeenCalled();
    expect(d.getGuest).not.toHaveBeenCalled();
    expect((r[0] as any).guest).toEqual({ fullName: 'Alt Bekannt' });
    expect(stats).toMatchObject({ moneyRequested: 0, guestFetched: 0, guestFromLocal: 1 });
  });

  it('neue Zeile: money und Gastname; geänderter Status: beides; laufender Aufenthalt: nur money', async () => {
    const r = [
      listItem('neu', 'inquiry', '2026-03-01'),
      listItem('status', 'confirmed', '2026-03-01'),
      listItem('laufend', 'confirmed', '2026-11-14'), // heute − 5 Tage: noch im Fenster
    ];
    const local = new Map<string, LocalInquiryState>([
      ['status', { status: 'inquiry', guest_name: 'Vorname' }],
      ['laufend', { status: 'confirmed', guest_name: 'Bleibt' }],
    ]);
    const d = deps();
    await enrichGuestyListReservations(r, local, d, { today });
    expect(d.getReservationsV3ByIds).toHaveBeenCalledWith(['neu', 'status', 'laufend']);
    expect(d.getGuest.mock.calls.map((c) => c[0])).toEqual(['g-neu', 'g-status']);
    expect((r[2] as any).guest).toEqual({ fullName: 'Bleibt' });
    expect(r.every((x: any) => x.money)).toBe(true);
  });

  it('fullMoneyRefresh (Force-Lauf): money für alle, Namen weiter aus dem Bestand', async () => {
    const r = [listItem('a', 'confirmed', '2025-03-01')];
    const local = new Map<string, LocalInquiryState>([['a', { status: 'confirmed', guest_name: 'X' }]]);
    const d = deps();
    await enrichGuestyListReservations(r, local, d, { today, fullMoneyRefresh: true });
    expect(d.getReservationsV3ByIds).toHaveBeenCalledWith(['a']);
    expect(d.getGuest).not.toHaveBeenCalled();
  });

  it('Fehler beim Nachladen sind non-fatal; erfolgloser Gastname wird 24 h nicht wiederholt', async () => {
    const d = {
      getReservationsV3ByIds: vi.fn(async () => { throw new Error('429'); }),
      getGuest: vi.fn(async () => { throw new Error('404'); }),
    };
    const local = new Map<string, LocalInquiryState>();
    const r1 = [listItem('a', 'inquiry', '2026-12-01')];
    const s1 = await enrichGuestyListReservations(r1, local, d, { today, nowMs: 1_000 });
    expect(s1.enrichErrors).toBe(2);
    expect((r1[0] as any).money).toBeUndefined();
    const r2 = [listItem('a', 'inquiry', '2026-12-01')];
    await enrichGuestyListReservations(r2, local, d, { today, nowMs: 1_000 + 60_000 });
    expect(d.getGuest).toHaveBeenCalledTimes(1);
    await enrichGuestyListReservations(r2, local, d, { today, nowMs: 1_000 + 25 * 3600_000 });
    expect(d.getGuest).toHaveBeenCalledTimes(2);
  });

  it('je guestId höchstens ein Abruf pro Lauf, Obergrenze je Lauf', async () => {
    const r = [
      listItem('x1', 'inquiry', '2026-12-01', 'same'), listItem('x2', 'inquiry', '2026-12-01', 'same'),
      ...Array.from({ length: MAX_GUEST_FETCHES_PER_RUN + 5 }, (_, i) => listItem(`n${i}`, 'inquiry', '2026-12-01')),
    ];
    const d = deps();
    const stats = await enrichGuestyListReservations(r, new Map(), d, { today });
    expect(d.getGuest).toHaveBeenCalledTimes(MAX_GUEST_FETCHES_PER_RUN);
    expect((r[1] as any).guest).toEqual({ fullName: 'Name same' });
    expect(stats.guestSkippedByCap).toBe(6);
  });

  it('Liste mit money/guest (alte Mock-Form) wird nicht angefasst', async () => {
    const r = [{ ...listItem('a', 'inquiry', '2026-12-01'), money: { hostPayout: 5 }, guest: { fullName: 'Da' } }];
    const d = deps();
    await enrichGuestyListReservations(r, new Map(), d, { today });
    expect(d.getReservationsV3ByIds).not.toHaveBeenCalled();
    expect(d.getGuest).not.toHaveBeenCalled();
  });
});

describe('#1099 AK5: inquiries-Zeile über v3 (search + by-ids + guests-crud) = Legacy', async () => {
  const { readFileSync } = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const { adaptV3SearchResult } = await import('../services/guesty-v3-adapter.js');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/guesty-v3');
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const cols = 'inquiry_id, listing_id, status, check_in, check_out, guest_name, guests_count, source, created_at_guesty, currency, total_price, host_payout, guest_total, price_basis';

  it.each(['manual', 'airbnb'])('%s: neue Zeile identisch, zweiter Lauf ohne Nachladen ebenfalls', async (kind) => {
    const legacy = load(`legacy-get-${kind}.json`);
    const v3 = load(`v3-by-ids-${kind}.json`);
    const guest = load(`guests-crud-${kind}.json`);
    const listingId = legacy.listingId;
    const item = () => adaptV3SearchResult(load(`v3-search-${kind}.json`).results[0], { timezoneFor: () => 'Europe/Berlin' });

    // vorher: Legacy-Objekt durch den gemeinsamen Mapper
    upsertGuestyInquiries([legacy]);
    const before = db.prepare(`SELECT ${cols} FROM inquiries`).get();
    db.exec('DELETE FROM inquiries');

    // nachher: syncInquiries über die v3-Wege
    listMock().mockResolvedValue(page([item()]));
    (guestyClient.getReservationsV3ByIds as any).mockResolvedValue(v3);
    (guestyClient.getGuest as any).mockResolvedValue(guest);
    const res = await syncInquiries(listingId);
    expect(res.success).toBe(true);
    expect(res.confirmedCount).toBe(1);
    expect(db.prepare(`SELECT ${cols} FROM inquiries`).get()).toEqual(before);

    // zweiter Lauf (Aufenthalt der Probe liegt in der Zukunft → money wird erneut geladen, Name aus dem Bestand)
    (guestyClient.getGuest as any).mockClear();
    await syncInquiries(listingId);
    expect(guestyClient.getGuest).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT ${cols} FROM inquiries`).all()).toEqual([before]);
  });
});
