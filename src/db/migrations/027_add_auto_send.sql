-- Migration: Auto-Send-Gate (Spec docs/superpowers/specs/2026-09-19-auto-send-gate-design.md)
-- Created: 2026-09-19
--
-- Entscheidung + Begründung des Gates je Entwurf, wer gesendet hat, und ob Micha
-- den Text vor dem Senden geändert hat (Schatten-Auswertung).
ALTER TABLE message_drafts ADD COLUMN auto_decision TEXT;        -- 'auto' | 'wait' | NULL
ALTER TABLE message_drafts ADD COLUMN auto_category TEXT;
ALTER TABLE message_drafts ADD COLUMN auto_flags TEXT;           -- JSON-Array
ALTER TABLE message_drafts ADD COLUMN auto_reason TEXT;
ALTER TABLE message_drafts ADD COLUMN auto_mode TEXT;            -- 'off' | 'shadow' | 'live'
ALTER TABLE message_drafts ADD COLUMN auto_judged_at TEXT;
ALTER TABLE message_drafts ADD COLUMN sent_by TEXT;              -- 'micha' | 'auto'
ALTER TABLE message_drafts ADD COLUMN sent_body_changed INTEGER; -- 1 = vor dem Senden geändert

CREATE INDEX idx_message_drafts_auto ON message_drafts(auto_decision, created_at);
CREATE INDEX idx_message_drafts_sent_by ON message_drafts(sent_by, sent_at);
