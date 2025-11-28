-- Migration: Add analytics table for GA4 data
-- Created: 2025-11-28
-- Description: Store Google Analytics 4 metrics for dashboard display

-- ============================================================================
-- ANALYTICS TABLE
-- Stores daily aggregated GA4 metrics
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                     -- Date of the analytics data (YYYY-MM-DD)

  -- Core Metrics
  pageviews INTEGER NOT NULL DEFAULT 0,   -- Total pageviews
  users INTEGER NOT NULL DEFAULT 0,       -- Active users
  sessions INTEGER NOT NULL DEFAULT 0,    -- Total sessions
  avg_session_duration REAL DEFAULT 0,    -- Average session duration in seconds

  -- Metadata
  last_synced_at TEXT NOT NULL,           -- When this data was fetched from GA4
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(date)
);

CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics(date);
CREATE INDEX IF NOT EXISTS idx_analytics_last_synced ON analytics(last_synced_at);

-- ============================================================================
-- ANALYTICS_TOP_PAGES TABLE
-- Stores top pages by pageviews
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_top_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                     -- Date this ranking applies to
  page_path TEXT NOT NULL,                -- Page URL path
  page_title TEXT,                        -- Page title
  pageviews INTEGER NOT NULL DEFAULT 0,   -- Pageviews for this page
  rank INTEGER NOT NULL,                  -- Ranking (1-10)

  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(date, rank)
);

CREATE INDEX IF NOT EXISTS idx_analytics_top_pages_date ON analytics_top_pages(date);

-- ============================================================================
-- ANALYTICS_SYNC_LOG TABLE
-- Tracks sync history for analytics data
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  date_range_start TEXT NOT NULL,         -- Start date of synced range
  date_range_end TEXT NOT NULL,           -- End date of synced range
  records_synced INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,     -- Boolean: 1=success, 0=failed
  error_message TEXT                      -- Error message if failed
);

CREATE INDEX IF NOT EXISTS idx_analytics_sync_log_synced_at ON analytics_sync_log(synced_at);

-- ============================================================================
-- TRIGGERS
-- Automatically update updated_at timestamps
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS update_analytics_timestamp
AFTER UPDATE ON analytics
BEGIN
  UPDATE analytics SET updated_at = datetime('now') WHERE id = NEW.id;
END;
