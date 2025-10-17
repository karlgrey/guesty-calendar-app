/**
 * Database Module
 *
 * Manages SQLite database connection and initialization.
 * Uses better-sqlite3 for synchronous, fast access.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDatabasePath } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database.Database | null = null;

/**
 * Initialize database connection
 */
export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = getDatabasePath();
  const dbDir = path.dirname(dbPath);

  // Create data directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Open database connection
  db = new Database(dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Optimize for performance
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache

  return db;
}

/**
 * Get database instance (throws if not initialized)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Execute schema SQL file to initialize/migrate database
 */
export function executeSchema(): void {
  const db = getDatabase();
  const schemaPath = path.resolve(__dirname, '../../schema.sql');

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Execute schema (split by semicolon and execute each statement)
  db.exec(schema);
}

/**
 * Check if database tables exist
 */
export function isDatabaseInitialized(): boolean {
  const db = getDatabase();

  const result = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM sqlite_master
       WHERE type = 'table'
       AND name IN ('listings', 'availability', 'quotes_cache')`
    )
    .get() as { count: number };

  return result.count === 3;
}

/**
 * Get database statistics
 */
export interface DatabaseStats {
  listings: number;
  availability: number;
  quotes: number;
  databaseSize: string;
}

export function getDatabaseStats(): DatabaseStats {
  const db = getDatabase();

  const listingsCount = db.prepare('SELECT COUNT(*) as count FROM listings').get() as { count: number };
  const availabilityCount = db.prepare('SELECT COUNT(*) as count FROM availability').get() as { count: number };
  const quotesCount = db.prepare('SELECT COUNT(*) as count FROM quotes_cache').get() as { count: number };

  // Get database file size
  const dbPath = getDatabasePath();
  const stats = fs.statSync(dbPath);
  const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

  return {
    listings: listingsCount.count,
    availability: availabilityCount.count,
    quotes: quotesCount.count,
    databaseSize: `${sizeInMB} MB`,
  };
}

/**
 * Clean up expired quotes from cache
 */
export function cleanupExpiredQuotes(): number {
  const db = getDatabase();

  const result = db.prepare(`DELETE FROM quotes_cache WHERE datetime(expires_at) < datetime('now')`).run();

  return result.changes;
}

/**
 * Create migrations table to track applied migrations
 */
function createMigrationsTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Get list of applied migrations
 */
function getAppliedMigrations(): Set<string> {
  const db = getDatabase();

  const rows = db.prepare('SELECT filename FROM migrations').all() as Array<{ filename: string }>;

  return new Set(rows.map((row) => row.filename));
}

/**
 * Run pending migrations
 */
export function runMigrations(): number {
  const db = getDatabase();

  // Create migrations table if it doesn't exist
  createMigrationsTable();

  // Get migrations directory
  const migrationsDir = path.resolve(__dirname, './migrations');

  if (!fs.existsSync(migrationsDir)) {
    return 0; // No migrations directory, nothing to do
  }

  // Get all migration files (sorted alphabetically)
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    return 0; // No migration files
  }

  // Get already applied migrations
  const appliedMigrations = getAppliedMigrations();

  // Find pending migrations
  const pendingMigrations = migrationFiles.filter((file) => !appliedMigrations.has(file));

  if (pendingMigrations.length === 0) {
    return 0; // No pending migrations
  }

  // Run each pending migration in a transaction
  for (const migrationFile of pendingMigrations) {
    const migrationPath = path.join(migrationsDir, migrationFile);
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

    const runMigration = db.transaction(() => {
      // Execute migration SQL
      db.exec(migrationSql);

      // Record migration as applied
      db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(migrationFile);
    });

    runMigration();
  }

  return pendingMigrations.length;
}