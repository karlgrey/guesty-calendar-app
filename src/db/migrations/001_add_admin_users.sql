-- Migration: Add admin_users table
-- Created: 2025-10-17
-- Description: Add admin users table for local authentication

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active);

CREATE TRIGGER IF NOT EXISTS update_admin_users_timestamp
AFTER UPDATE ON admin_users
BEGIN
  UPDATE admin_users SET updated_at = datetime('now') WHERE id = NEW.id;
END;
