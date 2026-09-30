-- Migration 033: Storno-Belege (Stornorechnung) zu Rechnungen (#771)
--
-- Neuer Dokumenttyp 'cancellation': negativer Beleg, der eine Rechnung
-- vollständig storniert. Nummer kommt aus dem RECHNUNGS-Nummernkreis
-- (YYYY-NNNN, lückenlos nach §14 UStG), die Originalrechnung bleibt
-- unverändert bestehen (GoBD: kein Löschen/Überschreiben).
--
-- SQLite kann CHECK-Constraints nicht ändern -> Tabelle neu aufbauen.
-- Keine andere Tabelle referenziert documents; Trigger und Indizes werden
-- neu angelegt.
--
-- Der FK documents.reservation_id -> reservations entfällt bewusst: Belege
-- müssen die lokale Reservierungszeile überleben (GoBD — der ETL räumt
-- stornierte Reservierungen ab, bisher samt Dokumenten). Außerdem gibt es
-- bereits verwaiste Belege (lokal: A-2025-0002), an denen ein Rebuild mit
-- FK unter foreign_keys=ON scheitern würde.

CREATE TABLE documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_type TEXT NOT NULL CHECK (document_type IN ('quote', 'invoice', 'cancellation')),
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
  accommodation_total INTEGER NOT NULL,
  accommodation_rate INTEGER NOT NULL,
  extra_guest_total INTEGER DEFAULT 0,
  extra_guest_rate INTEGER DEFAULT 0,
  extra_guest_nights INTEGER DEFAULT 0,
  cleaning_fee INTEGER DEFAULT 0,
  subtotal INTEGER NOT NULL,
  tax_rate REAL DEFAULT 7.0,
  tax_amount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  valid_until TEXT,
  service_period_start TEXT,
  service_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  discount_total INTEGER DEFAULT 0,
  discount_description TEXT,
  guest_notes TEXT,
  source TEXT,
  -- Nur bei document_type = 'cancellation': die stornierte Rechnung
  cancels_document_id INTEGER REFERENCES documents(id)
);

INSERT INTO documents_new (
  id, document_type, document_number, reservation_id,
  customer_name, customer_company, customer_street, customer_city, customer_zip, customer_country,
  check_in, check_out, nights, guests_count, guests_included,
  currency, accommodation_total, accommodation_rate,
  extra_guest_total, extra_guest_rate, extra_guest_nights,
  cleaning_fee, subtotal, tax_rate, tax_amount, total,
  valid_until, service_period_start, service_period_end,
  created_at, updated_at,
  discount_total, discount_description, guest_notes, source
)
SELECT
  id, document_type, document_number, reservation_id,
  customer_name, customer_company, customer_street, customer_city, customer_zip, customer_country,
  check_in, check_out, nights, guests_count, guests_included,
  currency, accommodation_total, accommodation_rate,
  extra_guest_total, extra_guest_rate, extra_guest_nights,
  cleaning_fee, subtotal, tax_rate, tax_amount, total,
  valid_until, service_period_start, service_period_end,
  created_at, updated_at,
  discount_total, discount_description, guest_notes, source
FROM documents;

-- AUTOINCREMENT-Stand retten: IDs früher gelöschter Belege nicht neu vergeben
CREATE TEMP TABLE _documents_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'documents';

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

UPDATE sqlite_sequence
  SET seq = MAX(seq, COALESCE((SELECT seq FROM _documents_seq), 0))
  WHERE name = 'documents';
DROP TABLE _documents_seq;

CREATE INDEX IF NOT EXISTS idx_documents_reservation ON documents(reservation_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_number ON documents(document_number);
-- Höchstens ein Storno-Beleg je Rechnung
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_cancels
  ON documents(cancels_document_id) WHERE cancels_document_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS documents_updated_at
  AFTER UPDATE ON documents
  FOR EACH ROW
BEGIN
  UPDATE documents SET updated_at = datetime('now') WHERE id = NEW.id;
END;
