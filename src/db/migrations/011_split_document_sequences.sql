-- Migration 011: Split document sequences into separate quote and invoice counters
--
-- Previously sequence_type='shared' was used for both quotes and invoices,
-- causing Rechnungsnummern-Lücken (e.g. quote 'A-2026-0007' consumed number 7,
-- leaving invoice 2026-0007 as a permanent gap). In Germany, invoice numbers
-- must be gap-free (§14 UStG), so we switch to independent counters per type.
--
-- Initial values are seeded from the highest existing number per type+year.

INSERT OR REPLACE INTO document_sequences (sequence_type, year, last_number, updated_at)
SELECT
  'invoice',
  CAST(SUBSTR(document_number, 1, 4) AS INTEGER),
  MAX(CAST(SUBSTR(document_number, 6, 4) AS INTEGER)),
  datetime('now')
FROM documents
WHERE document_type = 'invoice'
GROUP BY CAST(SUBSTR(document_number, 1, 4) AS INTEGER);

INSERT OR REPLACE INTO document_sequences (sequence_type, year, last_number, updated_at)
SELECT
  'quote',
  CAST(SUBSTR(document_number, 3, 4) AS INTEGER),
  MAX(CAST(SUBSTR(document_number, 8, 4) AS INTEGER)),
  datetime('now')
FROM documents
WHERE document_type = 'quote'
GROUP BY CAST(SUBSTR(document_number, 3, 4) AS INTEGER);

DELETE FROM document_sequences WHERE sequence_type = 'shared';
