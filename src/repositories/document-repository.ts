/**
 * Document Repository
 *
 * Database operations for quotes (Angebote) and invoices (Rechnungen).
 * Handles document storage and sequential number generation.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export type DocumentType = 'quote' | 'invoice';

export interface DocumentCustomer {
  name: string | null;
  company: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
}

export interface DocumentData {
  documentType: DocumentType;
  reservationId: string;
  customer: DocumentCustomer;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestsCount: number | null;
  guestsIncluded: number;
  currency: string;
  accommodationTotal: number;    // in cents
  accommodationRate: number;     // per night in cents
  extraGuestTotal: number;       // in cents
  extraGuestRate: number;        // per person-night in cents
  extraGuestNights: number;      // person-nights count
  cleaningFee: number;           // in cents
  discountTotal: number;         // in cents (negative value)
  discountDescription?: string;  // e.g., "50% Friends & Family Discount"
  subtotal: number;              // in cents
  taxRate: number;               // percentage (e.g., 7.0)
  taxAmount: number;             // in cents
  total: number;                 // in cents
  guestNotes?: string;           // notes for guests from Guesty
  validUntil?: string;           // for quotes
  servicePeriodStart?: string;   // for invoices
  servicePeriodEnd?: string;     // for invoices
}

export interface Document extends DocumentData {
  id: number;
  documentNumber: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRow {
  id: number;
  document_type: string;
  document_number: string;
  reservation_id: string;
  customer_name: string | null;
  customer_company: string | null;
  customer_street: string | null;
  customer_city: string | null;
  customer_zip: string | null;
  customer_country: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  guests_count: number | null;
  guests_included: number;
  currency: string;
  accommodation_total: number;
  accommodation_rate: number;
  extra_guest_total: number;
  extra_guest_rate: number;
  extra_guest_nights: number;
  cleaning_fee: number;
  discount_total: number;
  discount_description: string | null;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  guest_notes: string | null;
  valid_until: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    documentType: row.document_type as DocumentType,
    documentNumber: row.document_number,
    reservationId: row.reservation_id,
    customer: {
      name: row.customer_name,
      company: row.customer_company,
      street: row.customer_street,
      city: row.customer_city,
      zip: row.customer_zip,
      country: row.customer_country,
    },
    checkIn: row.check_in,
    checkOut: row.check_out,
    nights: row.nights,
    guestsCount: row.guests_count,
    guestsIncluded: row.guests_included,
    currency: row.currency,
    accommodationTotal: row.accommodation_total,
    accommodationRate: row.accommodation_rate,
    extraGuestTotal: row.extra_guest_total,
    extraGuestRate: row.extra_guest_rate,
    extraGuestNights: row.extra_guest_nights,
    cleaningFee: row.cleaning_fee,
    discountTotal: row.discount_total || 0,
    discountDescription: row.discount_description || undefined,
    subtotal: row.subtotal,
    taxRate: row.tax_rate,
    taxAmount: row.tax_amount,
    total: row.total,
    guestNotes: row.guest_notes || undefined,
    validUntil: row.valid_until || undefined,
    servicePeriodStart: row.service_period_start || undefined,
    servicePeriodEnd: row.service_period_end || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// NUMBER GENERATION
// ============================================================================

/**
 * Generate the next document number for a given type and year
 * Format: A-2025-0001 (quote) or 2025-0001 (invoice, no prefix)
 *
 * Uses a single shared sequence so that when a quote becomes an invoice,
 * they share the same number (e.g., A-2025-0001 → 2025-0001)
 */
export function getNextDocumentNumber(type: DocumentType): string {
  const db = getDatabase();
  const year = new Date().getFullYear();
  // Use 'shared' as the sequence type - one sequence for both quotes and invoices
  const sequenceType = 'shared';

  try {
    // Use a transaction to ensure atomicity
    const result = db.transaction(() => {
      // Try to get existing sequence
      const existing = db
        .prepare('SELECT last_number FROM document_sequences WHERE sequence_type = ? AND year = ?')
        .get(sequenceType, year) as { last_number: number } | undefined;

      let nextNumber: number;

      if (existing) {
        nextNumber = existing.last_number + 1;
        db.prepare('UPDATE document_sequences SET last_number = ?, updated_at = datetime(\'now\') WHERE sequence_type = ? AND year = ?')
          .run(nextNumber, sequenceType, year);
      } else {
        // Create new sequence starting at 1
        nextNumber = 1;
        db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)')
          .run(sequenceType, year, nextNumber);
      }

      return nextNumber;
    })();

    // Format: A-2025-0001 for quotes, 2025-0001 for invoices (no prefix)
    const formattedNumber = type === 'quote'
      ? `A-${year}-${String(result).padStart(4, '0')}`
      : `${year}-${String(result).padStart(4, '0')}`;

    logger.debug({ type, year, number: result, formatted: formattedNumber }, 'Generated document number');

    return formattedNumber;
  } catch (error) {
    logger.error({ error, type, year }, 'Failed to generate document number');
    throw new DatabaseError(
      `Failed to generate document number: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get document number for a reservation based on existing documents
 * If a document of the SAME type already exists, reuse its number
 * Otherwise generate a new number
 * Note: Quotes and invoices now have independent numbering
 */
export function getDocumentNumberForReservation(reservationId: string, type: DocumentType): string {
  const db = getDatabase();

  // Check if a document of the SAME type exists for this reservation
  const existingDoc = db
    .prepare('SELECT document_number FROM documents WHERE reservation_id = ? AND document_type = ? ORDER BY created_at ASC LIMIT 1')
    .get(reservationId, type) as { document_number: string } | undefined;

  if (existingDoc) {
    logger.debug({
      reservationId,
      existingNumber: existingDoc.document_number,
      type
    }, 'Reusing existing document number (same type)');

    return existingDoc.document_number;
  }

  // No document of this type exists, generate new number
  logger.debug({ reservationId, type }, 'Generating new independent document number');
  return getNextDocumentNumber(type);
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Check if a document already exists for a reservation
 */
export function getDocumentByReservation(
  reservationId: string,
  type: DocumentType
): Document | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare('SELECT * FROM documents WHERE reservation_id = ? AND document_type = ? ORDER BY created_at DESC LIMIT 1')
      .get(reservationId, type) as DocumentRow | undefined;

    return row ? rowToDocument(row) : null;
  } catch (error) {
    logger.error({ error, reservationId, type }, 'Failed to get document by reservation');
    throw new DatabaseError(
      `Failed to get document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get document by document number
 */
export function getDocumentByNumber(documentNumber: string): Document | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare('SELECT * FROM documents WHERE document_number = ?')
      .get(documentNumber) as DocumentRow | undefined;

    return row ? rowToDocument(row) : null;
  } catch (error) {
    logger.error({ error, documentNumber }, 'Failed to get document by number');
    throw new DatabaseError(
      `Failed to get document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get document by ID
 */
export function getDocumentById(id: number): Document | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare('SELECT * FROM documents WHERE id = ?')
      .get(id) as DocumentRow | undefined;

    return row ? rowToDocument(row) : null;
  } catch (error) {
    logger.error({ error, id }, 'Failed to get document by ID');
    throw new DatabaseError(
      `Failed to get document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Create a new document (quote or invoice)
 * Returns the created document with its assigned number
 */
export function createDocument(data: DocumentData): Document {
  const db = getDatabase();

  try {
    // Generate document number
    // Uses existing number if quote or invoice already exists for this reservation
    const documentNumber = getDocumentNumberForReservation(data.reservationId, data.documentType);

    const stmt = db.prepare(`
      INSERT INTO documents (
        document_type, document_number, reservation_id,
        customer_name, customer_company, customer_street, customer_city, customer_zip, customer_country,
        check_in, check_out, nights, guests_count, guests_included,
        currency, accommodation_total, accommodation_rate,
        extra_guest_total, extra_guest_rate, extra_guest_nights,
        cleaning_fee, discount_total, discount_description,
        subtotal, tax_rate, tax_amount, total,
        guest_notes, valid_until, service_period_start, service_period_end
      ) VALUES (
        @documentType, @documentNumber, @reservationId,
        @customerName, @customerCompany, @customerStreet, @customerCity, @customerZip, @customerCountry,
        @checkIn, @checkOut, @nights, @guestsCount, @guestsIncluded,
        @currency, @accommodationTotal, @accommodationRate,
        @extraGuestTotal, @extraGuestRate, @extraGuestNights,
        @cleaningFee, @discountTotal, @discountDescription,
        @subtotal, @taxRate, @taxAmount, @total,
        @guestNotes, @validUntil, @servicePeriodStart, @servicePeriodEnd
      )
    `);

    const result = stmt.run({
      documentType: data.documentType,
      documentNumber,
      reservationId: data.reservationId,
      customerName: data.customer.name,
      customerCompany: data.customer.company,
      customerStreet: data.customer.street,
      customerCity: data.customer.city,
      customerZip: data.customer.zip,
      customerCountry: data.customer.country,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      nights: data.nights,
      guestsCount: data.guestsCount,
      guestsIncluded: data.guestsIncluded,
      currency: data.currency,
      accommodationTotal: data.accommodationTotal,
      accommodationRate: data.accommodationRate,
      extraGuestTotal: data.extraGuestTotal,
      extraGuestRate: data.extraGuestRate,
      extraGuestNights: data.extraGuestNights,
      cleaningFee: data.cleaningFee,
      discountTotal: data.discountTotal || 0,
      discountDescription: data.discountDescription || null,
      subtotal: data.subtotal,
      taxRate: data.taxRate,
      taxAmount: data.taxAmount,
      total: data.total,
      guestNotes: data.guestNotes || null,
      validUntil: data.validUntil || null,
      servicePeriodStart: data.servicePeriodStart || null,
      servicePeriodEnd: data.servicePeriodEnd || null,
    });

    logger.info(
      { documentNumber, type: data.documentType, reservationId: data.reservationId },
      'Document created successfully'
    );

    // Return the created document
    return getDocumentById(result.lastInsertRowid as number)!;
  } catch (error) {
    logger.error({ error, reservationId: data.reservationId, type: data.documentType }, 'Failed to create document');
    throw new DatabaseError(
      `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Update an existing document with new data (keeps document number)
 */
export function updateDocument(id: number, data: Omit<DocumentData, 'documentType' | 'reservationId'>): Document {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE documents SET
        customer_name = @customerName,
        customer_company = @customerCompany,
        customer_street = @customerStreet,
        customer_city = @customerCity,
        customer_zip = @customerZip,
        customer_country = @customerCountry,
        check_in = @checkIn,
        check_out = @checkOut,
        nights = @nights,
        guests_count = @guestsCount,
        guests_included = @guestsIncluded,
        currency = @currency,
        accommodation_total = @accommodationTotal,
        accommodation_rate = @accommodationRate,
        extra_guest_total = @extraGuestTotal,
        extra_guest_rate = @extraGuestRate,
        extra_guest_nights = @extraGuestNights,
        cleaning_fee = @cleaningFee,
        discount_total = @discountTotal,
        discount_description = @discountDescription,
        subtotal = @subtotal,
        tax_rate = @taxRate,
        tax_amount = @taxAmount,
        total = @total,
        guest_notes = @guestNotes,
        valid_until = @validUntil,
        service_period_start = @servicePeriodStart,
        service_period_end = @servicePeriodEnd,
        updated_at = datetime('now')
      WHERE id = @id
    `);

    stmt.run({
      id,
      customerName: data.customer.name,
      customerCompany: data.customer.company,
      customerStreet: data.customer.street,
      customerCity: data.customer.city,
      customerZip: data.customer.zip,
      customerCountry: data.customer.country,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      nights: data.nights,
      guestsCount: data.guestsCount,
      guestsIncluded: data.guestsIncluded,
      currency: data.currency,
      accommodationTotal: data.accommodationTotal,
      accommodationRate: data.accommodationRate,
      extraGuestTotal: data.extraGuestTotal,
      extraGuestRate: data.extraGuestRate,
      extraGuestNights: data.extraGuestNights,
      cleaningFee: data.cleaningFee,
      discountTotal: data.discountTotal || 0,
      discountDescription: data.discountDescription || null,
      subtotal: data.subtotal,
      taxRate: data.taxRate,
      taxAmount: data.taxAmount,
      total: data.total,
      guestNotes: data.guestNotes || null,
      validUntil: data.validUntil || null,
      servicePeriodStart: data.servicePeriodStart || null,
      servicePeriodEnd: data.servicePeriodEnd || null,
    });

    logger.info({ id }, 'Document updated successfully');

    return getDocumentById(id)!;
  } catch (error) {
    logger.error({ error, id }, 'Failed to update document');
    throw new DatabaseError(
      `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Delete a document by ID
 */
export function deleteDocumentById(id: number): boolean {
  const db = getDatabase();

  try {
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id);

    if (result.changes > 0) {
      logger.info({ id }, 'Document deleted successfully');
      return true;
    }
    return false;
  } catch (error) {
    logger.error({ error, id }, 'Failed to delete document');
    throw new DatabaseError(
      `Failed to delete document: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * List all documents, optionally filtered by type
 */
export function listDocuments(type?: DocumentType, limit: number = 100): Document[] {
  const db = getDatabase();

  try {
    let query = 'SELECT * FROM documents';
    const params: any[] = [];

    if (type) {
      query += ' WHERE document_type = ?';
      params.push(type);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params) as DocumentRow[];

    return rows.map(rowToDocument);
  } catch (error) {
    logger.error({ error, type, limit }, 'Failed to list documents');
    throw new DatabaseError(
      `Failed to list documents: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get document sequence information including last invoice
 */
export function getDocumentSequenceInfo(year: number = new Date().getFullYear()): {
  year: number;
  lastNumber: number;
  nextNumber: number;
  lastInvoice: Document | null;
  lastQuote: Document | null;
} {
  const db = getDatabase();

  try {
    // Get sequence from document_sequences table
    const sequenceRow = db
      .prepare('SELECT last_number FROM document_sequences WHERE year = ? AND sequence_type = ?')
      .get(year, 'shared') as { last_number: number } | undefined;

    const lastNumber = sequenceRow?.last_number || 0;

    // Get last invoice document
    const lastInvoiceRow = db
      .prepare(`
        SELECT * FROM documents
        WHERE document_type = 'invoice'
        AND document_number LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(`${year}-%`) as DocumentRow | undefined;

    // Get last quote document
    const lastQuoteRow = db
      .prepare(`
        SELECT * FROM documents
        WHERE document_type = 'quote'
        AND document_number LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(`A-${year}-%`) as DocumentRow | undefined;

    return {
      year,
      lastNumber,
      nextNumber: lastNumber + 1,
      lastInvoice: lastInvoiceRow ? rowToDocument(lastInvoiceRow) : null,
      lastQuote: lastQuoteRow ? rowToDocument(lastQuoteRow) : null,
    };
  } catch (error) {
    logger.error({ error, year }, 'Failed to get document sequence info');
    throw new DatabaseError(
      `Failed to get document sequence info: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Set document sequence number for a year
 */
export function setDocumentSequenceNumber(year: number, newNumber: number): void {
  const db = getDatabase();

  try {
    // Ensure sequence record exists
    db.prepare(`
      INSERT INTO document_sequences (sequence_type, year, last_number)
      VALUES ('shared', ?, ?)
      ON CONFLICT(sequence_type, year) DO UPDATE SET last_number = ?
    `).run(year, newNumber, newNumber);

    logger.info({ year, newNumber }, 'Document sequence number updated');
  } catch (error) {
    logger.error({ error, year, newNumber }, 'Failed to set document sequence number');
    throw new DatabaseError(
      `Failed to set document sequence number: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get all documents for a reservation
 */
export function getDocumentsByReservation(reservationId: string): Document[] {
  const db = getDatabase();

  try {
    const rows = db
      .prepare('SELECT * FROM documents WHERE reservation_id = ? ORDER BY created_at DESC')
      .all(reservationId) as DocumentRow[];

    return rows.map(rowToDocument);
  } catch (error) {
    logger.error({ error, reservationId }, 'Failed to get documents for reservation');
    throw new DatabaseError(
      `Failed to get documents: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
