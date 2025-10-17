/**
 * Run Database Migrations Script
 *
 * Manually run pending migrations
 * Usage: npm run db:migrate
 */

import { initDatabase, runMigrations } from '../db/index.js';
import logger from '../utils/logger.js';

async function main() {
  try {
    logger.info('Database Migration Script');
    logger.info('=========================\n');

    // Initialize database connection
    logger.info('Connecting to database...');
    initDatabase();
    logger.info('✓ Database connection established\n');

    // Run migrations
    logger.info('Checking for pending migrations...');
    const migrationsApplied = runMigrations();

    if (migrationsApplied === 0) {
      logger.info('✓ No pending migrations. Database is up to date.');
    } else {
      logger.info(`✓ Successfully applied ${migrationsApplied} migration(s)`);
    }
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  }
}

main();
