/**
 * Create Admin Users Table
 *
 * Manually create the admin_users table
 * Usage: tsx src/scripts/create-admin-table.ts
 */

import { initDatabase } from '../db/index.js';

async function main() {
  try {
    console.log('Creating admin_users table...');

    const db = initDatabase();

    // Create the admin_users table
    db.exec(`
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
    `);

    console.log('✓ admin_users table created successfully!');

    // Verify the table exists
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'").get();

    if (result) {
      console.log('✓ Table verified');
    } else {
      console.error('✗ Table creation failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error creating admin_users table:', error);
    process.exit(1);
  }
}

main();
