/**
 * Database Reset Script
 *
 * Drop all tables and reinitialize with fresh schema.
 * Usage: npm run db:reset
 *
 * WARNING: This will delete all data!
 */

import readline from 'node:readline';
import { initDatabase, executeSchema, getDatabase, getDatabaseStats } from '../db/index.js';
import logger from '../utils/logger.js';

/**
 * Prompt user for confirmation
 */
function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Drop all tables
 */
function dropAllTables() {
  const db = getDatabase();

  // Get all table names
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;

  // Drop each table
  for (const { name } of tables) {
    db.prepare(`DROP TABLE IF EXISTS ${name}`).run();
    logger.info(`Dropped table: ${name}`);
  }

  // Drop views
  const views = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='view'`)
    .all() as Array<{ name: string }>;

  for (const { name } of views) {
    db.prepare(`DROP VIEW IF EXISTS ${name}`).run();
    logger.info(`Dropped view: ${name}`);
  }
}

async function main() {
  try {
    logger.info('Database Reset Script');
    logger.info('=====================\n');

    // Initialize database connection
    logger.info('Connecting to database...');
    initDatabase();
    logger.info('✓ Database connection established\n');

    // Show current stats
    try {
      const stats = getDatabaseStats();
      logger.info('Current database stats:');
      logger.info(stats);
      logger.info('');
    } catch {
      logger.info('Database tables do not exist yet\n');
    }

    // Confirm action
    logger.warn('⚠️  WARNING: This will DELETE ALL DATA in the database!');
    const confirmed = await confirm('Are you sure you want to continue? (y/N): ');

    if (!confirmed) {
      logger.info('Reset cancelled');
      process.exit(0);
    }

    // Drop all tables
    logger.info('\nDropping all tables...');
    dropAllTables();
    logger.info('✓ All tables dropped\n');

    // Execute schema
    logger.info('Executing schema...');
    executeSchema();
    logger.info('✓ Schema applied successfully\n');

    // Show new stats
    const newStats = getDatabaseStats();
    logger.info('✓ Database reset complete!');
    logger.info('New database stats:');
    logger.info(newStats);
  } catch (error) {
    logger.error({ error }, 'Database reset failed');
    process.exit(1);
  }
}

main();