-- Migration: Add reservations table
-- Created: 2025-10-17
-- Description: Store detailed reservation/booking information from Guesty API

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL UNIQUE,
  listing_id TEXT NOT NULL,

  -- Dates
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  check_in_localized TEXT,
  check_out_localized TEXT,
  nights_count INTEGER NOT NULL,

  -- Guest information
  guest_id TEXT,
  guest_name TEXT,
  guests_count INTEGER,
  adults_count INTEGER,
  children_count INTEGER,
  infants_count INTEGER,

  -- Booking details
  status TEXT NOT NULL,
  confirmation_code TEXT,
  source TEXT,
  platform TEXT,

  -- Times
  planned_arrival TEXT,
  planned_departure TEXT,

  -- Financial
  currency TEXT,
  total_price REAL,
  host_payout REAL,
  balance_due REAL,
  total_paid REAL,

  -- Metadata
  created_at_guesty TEXT,
  reserved_at TEXT,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_reservations_reservation_id ON reservations(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservations_listing_id ON reservations(listing_id);
CREATE INDEX IF NOT EXISTS idx_reservations_check_in ON reservations(check_in);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

-- Trigger to update timestamp
CREATE TRIGGER IF NOT EXISTS update_reservations_timestamp
AFTER UPDATE ON reservations
BEGIN
  UPDATE reservations SET updated_at = datetime('now') WHERE id = NEW.id;
END;
