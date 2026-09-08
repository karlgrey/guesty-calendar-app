import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { listDocumentsForAgent } from './document-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_type TEXT NOT NULL,
      document_number TEXT NOT NULL UNIQUE,
      reservation_id TEXT NOT NULL,
      customer_name TEXT,
      customer_company TEXT,
      customer_street TEXT,
      customer_city TEXT,
      customer_zip TEXT,
      customer_country TEXT,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      nights INTEGER NOT NULL,
      guests_count INTEGER,
      guests_included INTEGER DEFAULT 5,
      currency TEXT DEFAULT 'EUR',
      source TEXT,
      accommodation_total INTEGER NOT NULL,
      accommodation_rate INTEGER NOT NULL,
      extra_guest_total INTEGER DEFAULT 0,
      extra_guest_rate INTEGER DEFAULT 0,
      extra_guest_nights INTEGER DEFAULT 0,
      cleaning_fee INTEGER DEFAULT 0,
      discount_total INTEGER DEFAULT 0,
      discount_description TEXT,
      subtotal INTEGER NOT NULL,
      tax_rate REAL DEFAULT 7.0,
      tax_amount INTEGER NOT NULL,
      total INTEGER NOT NULL,
      guest_notes TEXT,
      valid_until TEXT,
      service_period_start TEXT,
      service_period_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE document_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_type TEXT NOT NULL,
      year INTEGER NOT NULL,
      last_number INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sequence_type, year)
    );
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id TEXT NOT NULL UNIQUE,
      listing_id TEXT
    );
  `);
  setDatabase(db);

  const insDoc = db.prepare(`
    INSERT INTO documents (
      document_type, document_number, reservation_id, customer_name, customer_company,
      check_in, check_out, nights, guests_count, currency, source,
      accommodation_total, accommodation_rate, subtotal, tax_amount, total, created_at
    ) VALUES (
      @documentType, @documentNumber, @reservationId, @customerName, @customerCompany,
      @checkIn, @checkOut, @nights, @guestsCount, @currency, @source,
      @accommodationTotal, @accommodationRate, @subtotal, @taxAmount, @total, @createdAt
    )
  `);

  // Rechnungen 2026
  insDoc.run({
    documentType: 'invoice', documentNumber: '2026-0034', reservationId: 'res-farmhouse-1',
    customerName: 'Anna Beispiel', customerCompany: null, checkIn: '2026-09-01', checkOut: '2026-09-03',
    nights: 2, guestsCount: 2, currency: 'EUR', source: 'Direct',
    accommodationTotal: 20000, accommodationRate: 10000, subtotal: 20000, taxAmount: 1400, total: 21400,
    createdAt: '2026-09-08T09:00:00.000Z',
  });
  insDoc.run({
    documentType: 'invoice', documentNumber: '2026-0035', reservationId: 'res-u19-1',
    customerName: 'Bob Muster', customerCompany: 'Muster GmbH', checkIn: '2026-09-05', checkOut: '2026-09-06',
    nights: 1, guestsCount: 1, currency: 'EUR', source: 'Airbnb',
    accommodationTotal: 10000, accommodationRate: 10000, subtotal: 10000, taxAmount: 700, total: 10700,
    createdAt: '2026-09-08T10:00:00.000Z',
  });
  // Angebot 2026 (gleiches Jahr, andere Nummernkreis-Praefix — darf Rechnungs-Jahresfilter nicht kreuzen)
  insDoc.run({
    documentType: 'quote', documentNumber: 'A-2026-0045', reservationId: 'res-farmhouse-2',
    customerName: 'Clara Test', customerCompany: null, checkIn: '2026-10-01', checkOut: '2026-10-04',
    nights: 3, guestsCount: 4, currency: 'EUR', source: 'Direct',
    accommodationTotal: 30000, accommodationRate: 10000, subtotal: 30000, taxAmount: 2100, total: 32100,
    createdAt: '2026-09-08T11:00:00.000Z',
  });
  // Rechnung aus 2025 (fuer Jahresfilter-Test)
  insDoc.run({
    documentType: 'invoice', documentNumber: '2025-0099', reservationId: 'res-farmhouse-3',
    customerName: 'Dieter Alt', customerCompany: null, checkIn: '2025-12-01', checkOut: '2025-12-03',
    nights: 2, guestsCount: 2, currency: 'EUR', source: 'Direct',
    accommodationTotal: 20000, accommodationRate: 10000, subtotal: 20000, taxAmount: 1400, total: 21400,
    createdAt: '2025-12-01T09:00:00.000Z',
  });

  db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)').run('invoice', 2026, 35);
  db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)').run('quote', 2026, 45);

  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-farmhouse-1', 'guesty-farmhouse');
  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-farmhouse-2', 'guesty-farmhouse');
  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-u19-1', 'guesty-u19');
  // res-farmhouse-3 hat bewusst KEINE lokale reservations-Zeile (aeltere/aufgeraeumte Reservierung)
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('listDocumentsForAgent', () => {
  it('listet alle Dokumente sortiert nach documentNumber aufsteigend', () => {
    const docs = listDocumentsForAgent();
    expect(docs.map((d) => d.documentNumber)).toEqual(['2025-0099', '2026-0034', '2026-0035', 'A-2026-0045']);
  });

  it('filtert nach Jahr, ohne Praefix-Kreuzung zwischen Rechnung/Angebot', () => {
    const docs = listDocumentsForAgent({ year: 2026 });
    expect(docs.map((d) => d.documentNumber)).toEqual(['2026-0034', '2026-0035', 'A-2026-0045']);
  });

  it('filtert nach type', () => {
    const docs = listDocumentsForAgent({ type: 'invoice' });
    expect(docs.map((d) => d.documentNumber)).toEqual(['2025-0099', '2026-0034', '2026-0035']);
  });

  it('kombiniert Jahr- und Typfilter', () => {
    const docs = listDocumentsForAgent({ year: 2026, type: 'invoice' });
    expect(docs.map((d) => d.documentNumber)).toEqual(['2026-0034', '2026-0035']);
  });

  it('filtert nach listingId (Property-Zuordnung ueber lokale reservations-Tabelle)', () => {
    const docs = listDocumentsForAgent({ listingId: 'guesty-farmhouse' });
    expect(docs.map((d) => d.documentNumber)).toEqual(['2026-0034', 'A-2026-0045']);
  });

  it('Dokumente ohne lokale reservations-Zeile fallen beim Property-Filter raus', () => {
    // res-farmhouse-3 (2025-0099) hat keine reservations-Zeile -> beim
    // Property-Filter unauffindbar, taucht aber im ungefilterten Ergebnis auf.
    expect(listDocumentsForAgent().map((d) => d.documentNumber)).toContain('2025-0099');
    expect(listDocumentsForAgent({ listingId: 'guesty-farmhouse' }).map((d) => d.documentNumber)).not.toContain('2025-0099');
  });

  it('liest NIE aus document_sequences und veraendert sie nicht', () => {
    const before = db.prepare('SELECT * FROM document_sequences ORDER BY sequence_type').all();
    listDocumentsForAgent({ year: 2026, type: 'invoice', listingId: 'guesty-farmhouse' });
    const after = db.prepare('SELECT * FROM document_sequences ORDER BY sequence_type').all();
    expect(after).toEqual(before);
  });

  it('mappt Felder korrekt (u.a. total in Cent, customer, source)', () => {
    const [doc] = listDocumentsForAgent({ year: 2026, type: 'invoice', listingId: 'guesty-u19' });
    expect(doc).toMatchObject({
      documentNumber: '2026-0035',
      documentType: 'invoice',
      reservationId: 'res-u19-1',
      customer: expect.objectContaining({ name: 'Bob Muster', company: 'Muster GmbH' }),
      checkIn: '2026-09-05',
      checkOut: '2026-09-06',
      nights: 1,
      guestsCount: 1,
      total: 10700,
      currency: 'EUR',
      source: 'Airbnb',
    });
  });
});
