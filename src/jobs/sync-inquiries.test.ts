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
import { syncInquiries } from './sync-inquiries.js';

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
