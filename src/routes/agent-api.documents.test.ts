import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, agentApiKey: 'test-agent-key-0123456789abcdef0123456789' } };
});
// Diese Routen sind fuer /documents irrelevant, muessen aber gemockt werden,
// damit der Router-Import (agent-api.ts importiert alles top-level) nicht auf
// echte Guesty-/Service-Verbindungen trifft — Muster aus agent-api.test.ts.
vi.mock('../services/reservation-service.js', () => ({
  createOfferReservation: vi.fn(), confirmOfferReservation: vi.fn(), releaseOfferReservation: vi.fn(),
}));
vi.mock('../services/document-service.js', () => ({
  createOrGetDocument: vi.fn(), refreshDocument: vi.fn(),
}));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: { getReservation: vi.fn(), updateGuest: vi.fn() },
}));
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsUpdatedSince: vi.fn(), getThreadById: vi.fn(), getMessagesByThread: vi.fn(),
}));
vi.mock('../utils/thread-property.js', () => ({ propertyForBadge: vi.fn() }));
vi.mock('../jobs/consistency-check.js', () => ({
  runConsistencyCheck: vi.fn(), listOpenReservations: vi.fn(),
}));

// document-repository.js NICHT gemockt — /documents laeuft real gegen eine
// In-Memory-SQLite-DB, damit auch die harte Regel "document_sequences bleibt
// unangetastet" echt geprueft werden kann (Muster aus consistency-check.test.ts
// [Mocking der Peripherie] + bi-report-queries.test.ts [echte In-Memory-DB]).

import agentApiRoutes from './agent-api.js';

let server: Server; let base: string;
let db: Database.Database;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };

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
  insDoc.run({
    documentType: 'invoice', documentNumber: '2026-0034', reservationId: 'res-farmhouse-1',
    customerName: 'Anna Beispiel', customerCompany: null, checkIn: '2026-09-01', checkOut: '2026-09-03',
    nights: 2, guestsCount: 2, currency: 'EUR', source: 'Direct',
    accommodationTotal: 20000, accommodationRate: 10000, subtotal: 20000, taxAmount: 1400, total: 21400,
    createdAt: '2026-09-08T09:00:00.000Z',
  });
  insDoc.run({
    documentType: 'invoice', documentNumber: '2026-0035', reservationId: 'res-farmhouse-2',
    customerName: 'Bob Muster', customerCompany: 'Muster GmbH', checkIn: '2026-09-05', checkOut: '2026-09-06',
    nights: 1, guestsCount: 1, currency: 'EUR', source: 'Airbnb',
    accommodationTotal: 10000, accommodationRate: 10000, subtotal: 10000, taxAmount: 700, total: 10700,
    createdAt: '2026-09-08T10:00:00.000Z',
  });
  insDoc.run({
    documentType: 'quote', documentNumber: 'A-2026-0045', reservationId: 'res-farmhouse-3',
    customerName: 'Clara Test', customerCompany: null, checkIn: '2026-10-01', checkOut: '2026-10-04',
    nights: 3, guestsCount: 4, currency: 'EUR', source: 'Direct',
    accommodationTotal: 30000, accommodationRate: 10000, subtotal: 30000, taxAmount: 2100, total: 32100,
    createdAt: '2026-09-08T11:00:00.000Z',
  });
  insDoc.run({
    documentType: 'invoice', documentNumber: '2025-0099', reservationId: 'res-u19-1',
    customerName: 'Dieter Alt', customerCompany: null, checkIn: '2025-12-01', checkOut: '2025-12-03',
    nights: 2, guestsCount: 2, currency: 'EUR', source: 'Direct',
    accommodationTotal: 20000, accommodationRate: 10000, subtotal: 20000, taxAmount: 1400, total: 21400,
    createdAt: '2025-12-01T09:00:00.000Z',
  });

  db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)').run('invoice', 2026, 35);
  db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)').run('quote', 2026, 45);

  // farmhouse-Slug hat guestyPropertyId '686d1e927ae7af00234115ad' in data/properties.json.
  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-farmhouse-1', '686d1e927ae7af00234115ad');
  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-farmhouse-2', '686d1e927ae7af00234115ad');
  db.prepare('INSERT INTO reservations (reservation_id, listing_id) VALUES (?, ?)').run('res-farmhouse-3', '686d1e927ae7af00234115ad');
  // res-u19-1 (2025-0099) hat KEINE lokale reservations-Zeile mehr.
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('GET /api/agent/documents', () => {
  it('401 ohne Key', async () => {
    const r = await fetch(`${base}/api/agent/documents`);
    expect(r.status).toBe(401);
  });

  it('listet alle Dokumente sortiert nach documentNumber aufsteigend', async () => {
    const r = await fetch(`${base}/api/agent/documents`, { headers: KEY });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.count).toBe(4);
    expect(body.documents.map((d: any) => d.documentNumber)).toEqual(['2025-0099', '2026-0034', '2026-0035', 'A-2026-0045']);
    expect(typeof body.fetchedAt).toBe('string');
  });

  it('mappt Felder korrekt (total in EUR als Zahl, customer, source, ids)', async () => {
    const r = await fetch(`${base}/api/agent/documents?year=2026&type=invoice`, { headers: KEY });
    const body = await r.json();
    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]).toMatchObject({
      documentNumber: '2026-0034',
      documentType: 'invoice',
      reservationId: 'res-farmhouse-1',
      customerName: 'Anna Beispiel',
      customerCompany: null,
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      nights: 2,
      guestsCount: 2,
      total: 214,
      currency: 'EUR',
      source: 'Direct',
      createdAt: '2026-09-08T09:00:00.000Z',
    });
    expect(typeof body.documents[0].id).toBe('number');
  });

  it('year-Filter kreuzt Rechnungs-/Angebots-Praefixe nicht', async () => {
    const r = await fetch(`${base}/api/agent/documents?year=2026`, { headers: KEY });
    const body = await r.json();
    expect(body.documents.map((d: any) => d.documentNumber)).toEqual(['2026-0034', '2026-0035', 'A-2026-0045']);
  });

  it('type-Filter: quote', async () => {
    const r = await fetch(`${base}/api/agent/documents?type=quote`, { headers: KEY });
    const body = await r.json();
    expect(body.documents.map((d: any) => d.documentNumber)).toEqual(['A-2026-0045']);
  });

  it('400 bei ungueltigem type', async () => {
    const r = await fetch(`${base}/api/agent/documents?type=foo`, { headers: KEY });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/type/);
  });

  it('400 bei unbekanntem property-Slug', async () => {
    const r = await fetch(`${base}/api/agent/documents?property=nichtvorhanden`, { headers: KEY });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/property/);
  });

  it('property-Filter laesst nur Dokumente mit lokaler reservations-Zuordnung durch', async () => {
    const r = await fetch(`${base}/api/agent/documents?property=farmhouse`, { headers: KEY });
    const body = await r.json();
    // res-u19-1 (2025-0099) hat keine lokale reservations-Zeile -> faellt raus,
    // obwohl es (real) zu u19 gehoeren wuerde.
    expect(body.documents.map((d: any) => d.documentNumber)).toEqual(['2026-0034', '2026-0035', 'A-2026-0045']);
  });

  it('HARTE REGEL: document_sequences bleibt nach dem Aufruf unveraendert', async () => {
    const before = db.prepare('SELECT * FROM document_sequences ORDER BY sequence_type').all();
    const r = await fetch(`${base}/api/agent/documents?year=2026&type=invoice&property=farmhouse`, { headers: KEY });
    expect(r.status).toBe(200);
    const after = db.prepare('SELECT * FROM document_sequences ORDER BY sequence_type').all();
    expect(after).toEqual(before);
    // ...und auch die Anzahl Dokumente hat sich nicht veraendert (kein Neuanlegen).
    const docCount = db.prepare('SELECT COUNT(*) as n FROM documents').get() as { n: number };
    expect(docCount.n).toBe(4);
  });
});
