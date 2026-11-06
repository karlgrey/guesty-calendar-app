-- Migration 039: Ursprungstext eines Entwurfs sichern (#1062, Folge #1044 Entscheid A)
--
-- Beim Senden mit Änderung überschreibt POST /admin/messages/drafts/:id/send den body mit dem
-- gesendeten Text. original_body hält den Entwurfstext VOR dem ersten Edit fest (nur einmal
-- gesetzt, spätere Edits lassen ihn stehen), damit /api/agent/auto-send/decisions für
-- geänderte Fälle Entwurf, gesendeten Text und Diff liefern kann.
-- NICHT zu verwechseln mit previous_body (Migration 032): Vorversion einer automatischen
-- Neugenerierung, nicht Michas Bearbeitung.
--
-- original_body: NULL (nie bearbeitet bzw. vor Migration 039 gesendet) | Text vor dem ersten Edit

ALTER TABLE message_drafts ADD COLUMN original_body TEXT;
