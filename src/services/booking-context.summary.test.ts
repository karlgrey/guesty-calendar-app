// #1187: resolveThreadBookingSummary — strukturierte Buchungs-/Anfragedaten für den
// Thread-Kopf und das Listen-Badge der Nachrichten-App (Zeitraum, Personen, Preis).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { resolveThreadBookingSummary } from './booking-context.js';
import type { MessageThread } from '../types/messages.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, guests_count INTEGER, adults_count INTEGER,
      children_count INTEGER, infants_count INTEGER, confirmation_code TEXT, source TEXT,
      platform TEXT, currency TEXT, total_price REAL, host_payout REAL
    );
    CREATE TABLE inquiries (
      id INTEGER PRIMARY KEY, inquiry_id TEXT UNIQUE, listing_id TEXT, status TEXT,
      check_in TEXT, check_out TEXT, guest_name TEXT, guests_count INTEGER, source TEXT,
      currency TEXT, total_price REAL, host_payout REAL
    );
  `);
  setDatabase(db);
});

afterEach(() => { resetDatabase(); db.close(); });

function thread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 't1', listing_id: 'L1', source: 'guesty', channel: 'airbnb2', guest_name: 'Guest',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1,
    reservation_id: null, inquiry_id: null, reservation_status: null, conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null,
    ai_no_reply_at: null, last_synced_at: '',
    ...over,
  };
}

function insertReservation(over: Record<string, unknown> = {}) {
  const row = {
    reservation_id: 'R1', listing_id: 'L1', check_in: '2026-12-01T15:00:00.000Z', check_out: '2026-12-04T12:00:00.000Z',
    check_in_localized: '2026-12-01', check_out_localized: '2026-12-04', nights_count: 3, status: 'confirmed',
    guests_count: 3, adults_count: 2, children_count: 1, infants_count: null, confirmation_code: 'HMABC',
    source: 'airbnb2', platform: 'airbnb2', currency: 'EUR', total_price: 1450, host_payout: 1234, ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO reservations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
}

function insertInquiry(over: Record<string, unknown> = {}) {
  const row = {
    inquiry_id: 'I1', listing_id: 'L1', status: 'inquiry', check_in: '2027-12-31', check_out: '2028-01-01',
    guest_name: 'Lisa', guests_count: 1, source: 'airbnb2', currency: null, total_price: null, host_payout: null, ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO inquiries (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
}

describe('resolveThreadBookingSummary', () => {
  it('returns null when the thread is not linked', () => {
    expect(resolveThreadBookingSummary(thread())).toBeNull();
  });

  it('returns null when the linked rows do not exist', () => {
    expect(resolveThreadBookingSummary(thread({ reservation_id: 'X', inquiry_id: 'Y' }))).toBeNull();
  });

  it('summarises a reservation with price and guest split', () => {
    insertReservation();
    const s = resolveThreadBookingSummary(thread({ reservation_id: 'R1', reservation_status: 'confirmed' }));
    expect(s).toEqual({
      kind: 'reservation', status: 'confirmed', checkIn: '2026-12-01', checkOut: '2026-12-04', nights: 3,
      guestsCount: 3, adults: 2, children: 1, hostPayout: 1234, totalPrice: 1450, currency: 'EUR', platform: 'airbnb2',
      guestPrice: null,
    });
  });

  it('prefers the reservation over the inquiry when both rows exist', () => {
    insertReservation({ reservation_id: 'G1' });
    insertInquiry({ inquiry_id: 'G1', guests_count: 7 });
    const s = resolveThreadBookingSummary(thread({ reservation_id: 'G1', inquiry_id: 'G1' }));
    expect(s?.kind).toBe('reservation');
    expect(s?.guestsCount).toBe(3);
  });

  it('falls back to the inquiry when reservation_id has no row (Guesty inquiry constellation)', () => {
    insertInquiry({ inquiry_id: 'G2', currency: 'EUR', total_price: 1450, host_payout: 1234 });
    const s = resolveThreadBookingSummary(thread({ reservation_id: 'G2', inquiry_id: 'G2' }));
    expect(s).toEqual({
      kind: 'inquiry', status: 'inquiry', checkIn: '2027-12-31', checkOut: '2028-01-01', nights: 1,
      guestsCount: 1, adults: null, children: null, hostPayout: 1234, totalPrice: 1450, currency: 'EUR', platform: 'airbnb2',
      guestPrice: null, // ohne price_basis (Altbestand vor Migration 043) kein Gastpreis
    });
  });

  it('#1242: Airbnb-Anfrage nur mit Netto-Auszahlung → berechneter Gastbetrag (derselbe wie im Kontext)', () => {
    db.exec('ALTER TABLE inquiries ADD COLUMN guest_total REAL; ALTER TABLE inquiries ADD COLUMN price_basis TEXT;');
    insertInquiry({ inquiry_id: 'D1', currency: 'EUR', total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
    const s = resolveThreadBookingSummary(thread({ inquiry_id: 'D1' }), { rates: { hostServiceFeeRate: 0.155, taxRate: 0.07 } });
    expect(s?.guestPrice).toEqual({ kind: 'estimated', inclTax: 3948.3, exclTax: 3690, currency: 'EUR', channel: 'Airbnb' });
    expect(resolveThreadBookingSummary(thread({ inquiry_id: 'D1' }), { rates: null })?.guestPrice).toBeNull();
  });

  it('inquiry without price yields null price fields', () => {
    insertInquiry();
    const s = resolveThreadBookingSummary(thread({ inquiry_id: 'I1' }));
    expect(s?.hostPayout).toBeNull();
    expect(s?.totalPrice).toBeNull();
    expect(s?.currency).toBeNull();
  });

  it('treats guests_count 0 (Guesty sync default for "unknown") as unknown', () => {
    insertInquiry({ guests_count: 0 });
    expect(resolveThreadBookingSummary(thread({ inquiry_id: 'I1' }))?.guestsCount).toBeNull();
  });

  it('uses the thread reservation_status over the row status for reservations', () => {
    insertReservation({ status: 'reserved' });
    expect(resolveThreadBookingSummary(thread({ reservation_id: 'R1', reservation_status: 'confirmed' }))?.status).toBe('confirmed');
  });

  it('works on a pre-040 inquiries table without money columns (null prices)', () => {
    db.exec('DROP TABLE inquiries; CREATE TABLE inquiries (id INTEGER PRIMARY KEY, inquiry_id TEXT UNIQUE, status TEXT, check_in TEXT, check_out TEXT, guest_name TEXT, guests_count INTEGER)');
    db.prepare("INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guests_count) VALUES ('I1','inquiry','2027-12-31','2028-01-01',1)").run();
    const s = resolveThreadBookingSummary(thread({ inquiry_id: 'I1' }));
    expect(s?.kind).toBe('inquiry');
    expect(s?.hostPayout).toBeNull();
  });
});
