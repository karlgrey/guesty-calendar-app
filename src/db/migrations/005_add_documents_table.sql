-- Migration: Add documents table for quotes and invoices
-- Created: 2025-12-01
-- Description: Stores generated quotes (Angebote) and invoices (Rechnungen) with sequential numbering

-- Documents table stores both quotes and invoices
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Document identification
  document_type TEXT NOT NULL CHECK (document_type IN ('quote', 'invoice')),
  document_number TEXT NOT NULL UNIQUE,  -- e.g., A-2025-0001 or R-2025-0001

  -- Link to reservation
  reservation_id TEXT NOT NULL,

  -- Customer data (snapshot at time of document creation)
  customer_name TEXT,
  customer_company TEXT,
  customer_street TEXT,
  customer_city TEXT,
  customer_zip TEXT,
  customer_country TEXT,

  -- Stay details (snapshot)
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL,
  guests_count INTEGER,
  guests_included INTEGER DEFAULT 5,

  -- Pricing (snapshot in cents to avoid floating point issues)
  currency TEXT DEFAULT 'EUR',
  accommodation_total INTEGER NOT NULL,      -- Total for accommodation (nights * rate)
  accommodation_rate INTEGER NOT NULL,       -- Per night rate
  extra_guest_total INTEGER DEFAULT 0,       -- Extra guest fees total
  extra_guest_rate INTEGER DEFAULT 0,        -- Per person-night rate
  extra_guest_nights INTEGER DEFAULT 0,      -- Person-nights count
  cleaning_fee INTEGER DEFAULT 0,
  subtotal INTEGER NOT NULL,                 -- Sum before tax
  tax_rate REAL DEFAULT 7.0,                 -- VAT percentage
  tax_amount INTEGER NOT NULL,               -- Calculated tax
  total INTEGER NOT NULL,                    -- Final amount

  -- Quote-specific fields
  valid_until TEXT,                          -- Quote expiry date

  -- Invoice-specific fields
  service_period_start TEXT,                 -- Leistungszeitraum start
  service_period_end TEXT,                   -- Leistungszeitraum end

  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Foreign key (soft - reservation might be deleted)
  FOREIGN KEY (reservation_id) REFERENCES reservations(reservation_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_documents_reservation ON documents(reservation_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_number ON documents(document_number);

-- Sequence tracking table for document numbers
CREATE TABLE IF NOT EXISTS document_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_type TEXT NOT NULL,  -- 'quote' or 'invoice'
  year INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sequence_type, year)
);

-- Trigger to auto-update updated_at
CREATE TRIGGER IF NOT EXISTS documents_updated_at
  AFTER UPDATE ON documents
  FOR EACH ROW
BEGIN
  UPDATE documents SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger for sequences
CREATE TRIGGER IF NOT EXISTS document_sequences_updated_at
  AFTER UPDATE ON document_sequences
  FOR EACH ROW
BEGIN
  UPDATE document_sequences SET updated_at = datetime('now') WHERE id = NEW.id;
END;
