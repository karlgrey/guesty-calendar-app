-- Migration: Add inquiries table for tracking inquiry-to-booking conversion
-- Created: 2025-11-20
-- Description: Tracks all inquiries and reservations to calculate conversion rates

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id TEXT NOT NULL UNIQUE,
  listing_id TEXT NOT NULL,

  -- Status: inquiry, confirmed, reserved, cancelled, declined
  status TEXT NOT NULL,

  -- Dates
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,

  -- Guest information
  guest_name TEXT,
  guests_count INTEGER,

  -- Source
  source TEXT,

  -- Metadata
  created_at_guesty TEXT,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inquiries_inquiry_id ON inquiries(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_listing_id ON inquiries(listing_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_check_in ON inquiries(check_in);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at_guesty ON inquiries(created_at_guesty);

CREATE TRIGGER IF NOT EXISTS update_inquiries_timestamp
AFTER UPDATE ON inquiries
BEGIN
  UPDATE inquiries SET updated_at = datetime('now') WHERE id = NEW.id;
END;
