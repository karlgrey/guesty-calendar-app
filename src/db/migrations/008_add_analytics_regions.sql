-- Migration: Add analytics regions table for Bundesland tracking
-- Created: 2026-01-29

CREATE TABLE IF NOT EXISTS analytics_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  region TEXT NOT NULL,
  users INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, region)
);

CREATE INDEX IF NOT EXISTS idx_analytics_regions_date ON analytics_regions(date);
