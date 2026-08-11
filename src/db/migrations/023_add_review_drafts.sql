-- Migration: add review_drafts table
-- Created: 2026-08-11
--
-- Auto-generated guest-review drafts (#377), created shortly after checkout.
-- One row per reservation (UNIQUE), mirroring the message_drafts approval-gate
-- pattern but scoped to a reservation instead of a message thread — a review
-- is written once per stay, not per message.
--
-- status:
--   'pending'      — LLM wrote a review, awaiting Michas Freigabe/Copy-Paste
--   'needs_review' — Problemfall (Beschwerde/Schaden/Storno-Streit/Eskalation)
--                    OR the LLM failed to produce text; body is NULL, flag_reason
--                    explains why. No auto-draft — Micha decides manually.
--   'done'         — Micha hat die Bewertung gepostet (Copy-Paste) und bestätigt
--   'discarded'    — verworfen, keine Bewertung nötig/gewollt

CREATE TABLE review_drafts (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  provider TEXT NOT NULL,                        -- 'hostex' | 'guesty'
  guest_name TEXT,
  check_out TEXT NOT NULL,                        -- YYYY-MM-DD (localized) — Grundlage fürs Verfallsdatum (+14 Tage, Airbnb-Frist)
  status TEXT NOT NULL DEFAULT 'pending',
  body TEXT,                                      -- NULL bei status='needs_review'
  flag_reason TEXT,                                -- gesetzt bei status='needs_review'
  generated_by TEXT NOT NULL DEFAULT 'llm',
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

CREATE UNIQUE INDEX idx_review_drafts_reservation ON review_drafts(reservation_id);
CREATE INDEX idx_review_drafts_listing_status ON review_drafts(listing_id, status);
