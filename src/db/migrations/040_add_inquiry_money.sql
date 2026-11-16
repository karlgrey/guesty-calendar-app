-- Migration 040: Preisdaten an Anfragen (#1187)
--
-- Die Nachrichten-App soll auch bei Anfragen (noch keine Zeile in reservations) Auszahlung
-- und Gastpreis zeigen. Guesty-Sync (sync-inquiries.ts) und Hostex-Sync (sync-reservations.ts)
-- befüllen die Spalten; Semantik wie reservations.currency/total_price/host_payout.
-- Upserts nutzen COALESCE: ein Payload ohne Preisdaten löscht keinen bekannten Wert.
--
-- currency:     NULL (unbekannt) | ISO-Code, z. B. 'EUR'
-- total_price:  NULL (unbekannt) | Gastpreis (Guesty: fareAccommodationAdjusted)
-- host_payout:  NULL (unbekannt) | Auszahlung an den Gastgeber

ALTER TABLE inquiries ADD COLUMN currency TEXT;
ALTER TABLE inquiries ADD COLUMN total_price REAL;
ALTER TABLE inquiries ADD COLUMN host_payout REAL;
