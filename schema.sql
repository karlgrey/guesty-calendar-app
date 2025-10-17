-- Guesty Calendar App - SQLite Schema
--
-- This schema defines the internal data model for caching Guesty API data.
-- See docs/DATA_MODEL.md for detailed documentation.

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- ============================================================================
-- LISTINGS TABLE
-- Stores property details, pricing configuration, and metadata
-- ============================================================================

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,                    -- Guesty listing ID
  title TEXT NOT NULL,
  nickname TEXT,                          -- Display name (optional, falls back to title)
  accommodates INTEGER NOT NULL,          -- Max guests
  bedrooms INTEGER,
  bathrooms REAL,
  property_type TEXT,
  timezone TEXT NOT NULL,                 -- IANA timezone (e.g., 'Europe/Berlin')

  -- Pricing
  currency TEXT NOT NULL,                 -- ISO 4217 code (EUR, USD, etc.)
  base_price REAL NOT NULL,               -- Base nightly rate
  weekend_base_price REAL,                -- Weekend rate (optional)
  cleaning_fee REAL NOT NULL DEFAULT 0,
  extra_person_fee REAL NOT NULL DEFAULT 0,
  guests_included INTEGER NOT NULL DEFAULT 1,

  -- Discounts (stored as factors: 0.90 = 10% off)
  weekly_price_factor REAL DEFAULT 1.0,
  monthly_price_factor REAL DEFAULT 1.0,

  -- Taxes (stored as JSON array)
  taxes TEXT NOT NULL DEFAULT '[]',       -- JSON array of tax objects

  -- Terms
  min_nights INTEGER NOT NULL DEFAULT 1,
  max_nights INTEGER,
  check_in_time TEXT,                     -- e.g., '16:00'
  check_out_time TEXT,                    -- e.g., '11:00'

  -- Metadata
  active INTEGER NOT NULL DEFAULT 1,      -- Boolean: 1=active, 0=inactive
  last_synced_at TEXT NOT NULL,           -- ISO 8601 timestamp (UTC)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(active);
CREATE INDEX IF NOT EXISTS idx_listings_last_synced ON listings(last_synced_at);

-- ============================================================================
-- AVAILABILITY TABLE
-- Stores daily availability and pricing for each listing
-- ============================================================================

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  date TEXT NOT NULL,                     -- ISO 8601 date (YYYY-MM-DD) in property timezone
  status TEXT NOT NULL CHECK(status IN ('available', 'blocked', 'booked')),
  price REAL NOT NULL,                    -- Nightly rate for this date
  min_nights INTEGER NOT NULL DEFAULT 1,

  -- Restrictions
  closed_to_arrival INTEGER DEFAULT 0,    -- Boolean: CTA (cannot check in)
  closed_to_departure INTEGER DEFAULT 0,  -- Boolean: CTD (cannot check out)

  -- Block details (optional)
  block_type TEXT,                        -- 'reservation', 'owner', 'manual', 'maintenance'
  block_ref TEXT,                         -- Reference ID for the block

  -- Metadata
  last_synced_at TEXT NOT NULL,           -- ISO 8601 timestamp (UTC)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  UNIQUE(listing_id, date)
);

CREATE INDEX IF NOT EXISTS idx_availability_listing_date ON availability(listing_id, date);
CREATE INDEX IF NOT EXISTS idx_availability_status ON availability(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_availability_last_synced ON availability(last_synced_at);

-- ============================================================================
-- QUOTES_CACHE TABLE
-- Caches complete price quotes for specific search criteria
-- ============================================================================

CREATE TABLE IF NOT EXISTS quotes_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  check_in TEXT NOT NULL,                 -- ISO 8601 date (YYYY-MM-DD)
  check_out TEXT NOT NULL,                -- ISO 8601 date (YYYY-MM-DD)
  guests INTEGER NOT NULL,

  -- Pricing breakdown
  nights INTEGER NOT NULL,
  currency TEXT NOT NULL,
  accommodation_fare REAL NOT NULL,       -- Total for all nights (after discounts)
  cleaning_fee REAL NOT NULL DEFAULT 0,
  extra_guest_fee REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  total_taxes REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL,

  -- Discount info
  discount_applied TEXT,                  -- 'weekly', 'monthly', or NULL
  discount_factor REAL,                   -- e.g., 0.90
  discount_savings REAL,                  -- Amount saved

  -- Full breakdown (stored as JSON for detailed display)
  breakdown TEXT NOT NULL,                -- JSON object

  -- Cache management
  expires_at TEXT NOT NULL,               -- ISO 8601 timestamp (UTC)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quotes_listing_dates ON quotes_cache(listing_id, check_in, check_out, guests);
CREATE INDEX IF NOT EXISTS idx_quotes_expires ON quotes_cache(expires_at);

-- ============================================================================
-- TRIGGERS
-- Automatically update updated_at timestamps
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS update_listings_timestamp
AFTER UPDATE ON listings
BEGIN
  UPDATE listings SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_availability_timestamp
AFTER UPDATE ON availability
BEGIN
  UPDATE availability SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- VIEWS
-- Convenient queries for common operations
-- ============================================================================

-- View: Active listings with fresh data (synced within 24 hours)
CREATE VIEW IF NOT EXISTS fresh_listings AS
SELECT *
FROM listings
WHERE active = 1
  AND datetime(last_synced_at) > datetime('now', '-24 hours');

-- View: Fresh availability (synced within 6 hours)
CREATE VIEW IF NOT EXISTS fresh_availability AS
SELECT *
FROM availability
WHERE datetime(last_synced_at) > datetime('now', '-6 hours');

-- View: Valid (non-expired) quotes
CREATE VIEW IF NOT EXISTS valid_quotes AS
SELECT *
FROM quotes_cache
WHERE datetime(expires_at) > datetime('now');

-- ============================================================================
-- ADMIN_USERS TABLE
-- Stores admin users for authentication
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,             -- Email address (used as username)
  name TEXT NOT NULL,                     -- Display name
  password_hash TEXT NOT NULL,            -- Bcrypt hashed password
  is_active INTEGER NOT NULL DEFAULT 1,   -- Boolean: 1=active, 0=disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_admin_users_timestamp
AFTER UPDATE ON admin_users
BEGIN
  UPDATE admin_users SET updated_at = datetime('now') WHERE id = NEW.id;
END;