/**
 * Database Initialization Script
 *
 * Manually initialize the database with schema.
 * Usage: npm run db:init
 */

import { initDatabase, executeSchema, isDatabaseInitialized, getDatabaseStats } from '../db/index.js';
import logger from '../utils/logger.js';

async function main() {
  try {
    logger.info('Database Initialization Script');
    logger.info('==============================\n');

    // Initialize database connection
    logger.info('Connecting to database...');
    initDatabase();
    logger.info('✓ Database connection established\n');

    // Check if already initialized
    if (isDatabaseInitialized()) {
      logger.warn('Database is already initialized!');
      logger.info('Current database stats:');
      const stats = getDatabaseStats();
      logger.info(stats);
      logger.info('\nTo reset the database, use: npm run db:reset');
      process.exit(0);
    }

    // Execute schema
    logger.info('Executing schema...');
    executeSchema();
    logger.info('✓ Schema applied successfully\n');

    // Verify initialization
    if (isDatabaseInitialized()) {
      logger.info('✓ Database initialized successfully!');
      const stats = getDatabaseStats();
      logger.info('Database stats:');
      logger.info(stats);
    } else {
      logger.error('✗ Database initialization verification failed');
      process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, 'Database initialization failed');
    process.exit(1);
  }
}

main();