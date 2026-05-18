-- Migration: Airbnb mail archive + state
-- Created: 2026-05-18
-- See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
-- Retention: 90 days, cleanup in sync-mail.ts after each poll

CREATE TABLE airbnb_mail_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_slug TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  imap_uid INTEGER NOT NULL,
  subject TEXT,
  from_address TEXT,
  received_at TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  detected_type TEXT,
  reservation_code TEXT,
  parse_status TEXT NOT NULL,
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_airbnb_mail_archive_property ON airbnb_mail_archive(property_slug);
CREATE INDEX idx_airbnb_mail_archive_received ON airbnb_mail_archive(received_at);
CREATE INDEX idx_airbnb_mail_archive_parse_status ON airbnb_mail_archive(parse_status);
CREATE INDEX idx_airbnb_mail_archive_reservation_code ON airbnb_mail_archive(reservation_code);

CREATE TABLE airbnb_mail_state (
  property_slug TEXT PRIMARY KEY,
  last_imap_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
);
