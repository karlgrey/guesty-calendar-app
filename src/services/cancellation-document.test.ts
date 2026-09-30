// #771: Storno-Beleg zu einer Rechnung + GoBD-Schutz der Belege im ETL.
// Läuft gegen eine echte In-Memory-SQLite mit schema.sql + allen Migrationen
// (inkl. 033), damit CHECK-Constraint, Unique-Index und Nummernkreis echt
// geprüft werden. Nur Puppeteer (PDF) und Guesty sind gemockt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase, executeSchema, runMigrations } from '../db/index.js';

vi.mock('./pdf-generator.js', () => ({
  pdfGenerator: { generatePDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-fake')) },
}));
vi.mock('./guesty-client.js', () => ({
  guestyClient: { getReservation: vi.fn(), getGuest: vi.fn() },
}));

import {
  createDocument,
  getDocumentById,
  getNextDocumentNumber,
  listDocumentsForAgent,
  getDocumentSequenceInfo,
  updateDocument,
  setDocumentSequenceNumber,
  type DocumentData,
} from '../repositories/document-repository.js';
import { createCancellationForInvoice, getCancellationWithPDF, buildCancellationData } from './document-service.js';
import { deleteStaleReservationsInRange, applyCancellationLocally } from '../repositories/reservation-repository.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';

let db: Database.Database;
const YEAR = new Date().getFullYear();

function invoiceData(overrides: Partial<DocumentData> = {}): DocumentData {
  return {
    documentType: 'invoice',
    reservationId: 'res-klinik',
    customer: { name: 'Frau Muster', company: 'Klinik am See', street: 'Seeweg 1', city: 'Rüdersdorf', zip: '15562', country: 'DE' },
    checkIn: '2027-07-02',
    checkOut: '2027-07-04',
    nights: 2,
    guestsCount: 20,
    guestsIncluded: 5,
    currency: 'EUR',
    source: 'manual',
    accommodationTotal: 450000,
    accommodationRate: 225000,
    extraGuestTotal: 0,
    extraGuestRate: 10000,
    extraGuestNights: 0,
    cleaningFee: 35000,
    discountTotal: -20000,
    subtotal: 465000,
    taxRate: 7,
    taxAmount: 53950,
    total: 518950,
    servicePeriodStart: '2027-07-02',
    servicePeriodEnd: '2027-07-04',
    ...overrides,
  };
}

function insertReservation(id: string, status: string, listingId = 'listing-fh') {
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, nights_count, status, last_synced_at)
              VALUES (?, ?, '2027-07-02', '2027-07-04', 2, ?, datetime('now'))`).run(id, listingId, status);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setDatabase(db);
  executeSchema();
  runMigrations();
  db.prepare(`INSERT INTO listings (id, title, accommodates, timezone, currency, base_price, last_synced_at)
              VALUES ('listing-fh', 'Farmhouse', 20, 'Europe/Berlin', 'EUR', 1000, datetime('now'))`).run();
  insertReservation('res-klinik', 'confirmed');
  setDocumentSequenceNumber(YEAR, 'invoice', 34);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('Storno-Beleg (#771)', () => {
  it('bekommt die nächste RECHNUNGS-Nummer, negative Beträge und verweist auf die Rechnung', async () => {
    const invoice = createDocument(invoiceData());
    expect(invoice.documentNumber).toBe(`${YEAR}-0035`);

    const { document, isNew, invoice: inv } = await createCancellationForInvoice('res-klinik');
    expect(isNew).toBe(true);
    expect(inv.id).toBe(invoice.id);
    expect(document.documentType).toBe('cancellation');
    expect(document.documentNumber).toBe(`${YEAR}-0036`);
    expect(document.cancelsDocumentId).toBe(invoice.id);
    expect(document.total).toBe(-518950);
    expect(document.subtotal).toBe(-465000);
    expect(document.taxAmount).toBe(-53950);
    expect(document.accommodationTotal).toBe(-450000);
    expect(document.cleaningFee).toBe(-35000);
    expect(document.discountTotal).toBe(20000);
    expect(document.customer.company).toBe('Klinik am See');

    // Nummernkreis: Storno verbraucht die Rechnungsnummer, nächste Rechnung = 0037
    expect(getNextDocumentNumber('invoice')).toBe(`${YEAR}-0037`);
  });

  it('lässt die Originalrechnung unverändert (GoBD)', async () => {
    const invoice = createDocument(invoiceData());
    const before = db.prepare('SELECT * FROM documents WHERE id = ?').get(invoice.id);
    await createCancellationForInvoice('res-klinik');
    const after = db.prepare('SELECT * FROM documents WHERE id = ?').get(invoice.id);
    expect(after).toEqual(before);
  });

  it('ist idempotent: zweiter Aufruf liefert denselben Beleg, keine neue Nummer', async () => {
    createDocument(invoiceData());
    const first = await createCancellationForInvoice('res-klinik');
    const second = await createCancellationForInvoice('res-klinik');
    expect(second.isNew).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(getNextDocumentNumber('invoice')).toBe(`${YEAR}-0037`);
  });

  it('404 ohne Rechnung — und verbraucht dabei keine Nummer', async () => {
    await expect(createCancellationForInvoice('res-klinik')).rejects.toBeInstanceOf(NotFoundError);
    expect(getNextDocumentNumber('invoice')).toBe(`${YEAR}-0035`);
  });

  it('Unique-Index: höchstens ein Storno-Beleg je Rechnung', () => {
    const invoice = createDocument(invoiceData());
    createDocument(buildCancellationData(invoice));
    expect(() => createDocument(buildCancellationData(invoice))).toThrow();
  });

  it('stornierte Rechnung und Storno-Beleg sind gegen updateDocument (Refresh) gesperrt', async () => {
    const invoice = createDocument(invoiceData());
    const { document } = await createCancellationForInvoice('res-klinik');
    const { documentType: _a, reservationId: _b, ...upd } = invoiceData({ total: 1 });
    expect(() => updateDocument(invoice.id, upd)).toThrow(ConflictError);
    expect(() => updateDocument(document.id, upd)).toThrow(ConflictError);
    expect(getDocumentById(invoice.id)!.total).toBe(518950);
  });

  it('nicht stornierte Rechnung bleibt per Refresh aktualisierbar', () => {
    const invoice = createDocument(invoiceData());
    const { documentType: _a, reservationId: _b, ...upd } = invoiceData({ total: 1 });
    expect(updateDocument(invoice.id, upd).total).toBe(1);
  });

  it('GET /documents-Projektion listet den Storno-Beleg (Typfilter + Jahr)', async () => {
    createDocument(invoiceData());
    await createCancellationForInvoice('res-klinik');
    const all = listDocumentsForAgent({ year: YEAR });
    expect(all.map((d) => [d.documentNumber, d.documentType])).toEqual([
      [`${YEAR}-0035`, 'invoice'],
      [`${YEAR}-0036`, 'cancellation'],
    ]);
    expect(listDocumentsForAgent({ type: 'cancellation' })).toHaveLength(1);
  });

  it('Sequenz-Info zeigt den Storno-Beleg als letzten Beleg des Rechnungskreises', async () => {
    createDocument(invoiceData());
    await createCancellationForInvoice('res-klinik');
    const info = getDocumentSequenceInfo(YEAR);
    expect(info.invoice.lastNumber).toBe(36);
    expect(info.invoice.lastDocument?.documentNumber).toBe(`${YEAR}-0036`);
  });

  it('getCancellationWithPDF legt nie an', async () => {
    createDocument(invoiceData());
    expect(await getCancellationWithPDF('res-klinik')).toBeNull();
    expect(getNextDocumentNumber('invoice')).toBe(`${YEAR}-0036`);
  });
});

describe('ETL-Stale-Delete schützt Belege (#771, GoBD)', () => {
  it('Reservierungszeile wird wie bisher gelöscht (reservations = aktive Buchungen) — Rechnung und Storno bleiben', async () => {
    createDocument(invoiceData());
    await createCancellationForInvoice('res-klinik');

    const deleted = deleteStaleReservationsInRange('listing-fh', '2027-01-01', '2027-12-31', []);
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE reservation_id = ?').get('res-klinik')).toEqual({ n: 0 });
    expect(listDocumentsForAgent({}).map((d) => d.documentType)).toEqual(['invoice', 'cancellation']);
  });

  it('Hold nur mit Angebot wird samt Angebot abgeräumt (bisheriges Verhalten)', () => {
    insertReservation('res-hold', 'reserved');
    createDocument(invoiceData({ documentType: 'quote', reservationId: 'res-hold' }));
    const deleted = deleteStaleReservationsInRange('listing-fh', '2027-01-01', '2027-12-31', ['res-klinik']);
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE reservation_id = ?').get('res-hold')).toEqual({ n: 0 });
  });

  it('bestätigte Buchung mit Angebot UND Rechnung: nur das Angebot fällt weg', () => {
    createDocument(invoiceData({ documentType: 'quote' }));
    createDocument(invoiceData());
    deleteStaleReservationsInRange('listing-fh', '2027-01-01', '2027-12-31', []);
    expect(listDocumentsForAgent({ type: 'quote' })).toHaveLength(0);
    expect(listDocumentsForAgent({ type: 'invoice' })).toHaveLength(1);
  });

  it('Belege überleben auch ohne lokale Reservierungszeile (kein FK mehr)', () => {
    const invoice = createDocument(invoiceData({ reservationId: 'res-unbekannt' }));
    expect(getDocumentById(invoice.id)?.reservationId).toBe('res-unbekannt');
  });
});

describe('applyCancellationLocally (#771)', () => {
  it('löscht die reservations-Zeile (wie #660), setzt inquiries-Status, Belege bleiben', async () => {
    createDocument(invoiceData());
    await createCancellationForInvoice('res-klinik');
    db.prepare(`INSERT INTO inquiries (inquiry_id, listing_id, status, check_in, check_out, last_synced_at) VALUES ('res-klinik', 'listing-fh', 'confirmed', '2027-07-02', '2027-07-04', datetime('now'))`).run();
    expect(applyCancellationLocally('res-klinik', 'canceled')).toEqual({ reservations: 1, inquiries: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE reservation_id = 'res-klinik'`).get()).toEqual({ n: 0 });
    expect((db.prepare(`SELECT status FROM inquiries WHERE inquiry_id = 'res-klinik'`).get() as any).status).toBe('canceled');
    expect(listDocumentsForAgent({})).toHaveLength(2);
    // idempotent
    expect(applyCancellationLocally('res-klinik', 'canceled')).toEqual({ reservations: 0, inquiries: 1 });
  });
});
