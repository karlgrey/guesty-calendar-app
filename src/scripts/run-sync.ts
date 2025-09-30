/**
 * Manual Sync Script
 *
 * Run ETL job manually from command line.
 * Usage: npm run sync
 */

import { initDatabase, executeSchema, isDatabaseInitialized } from '../db/index.js';
import { runETLJob } from '../jobs/etl-job.js';
import logger from '../utils/logger.js';

async function main() {
  try {
    logger.info('Manual Sync Script');
    logger.info('==================\n');

    // Initialize database
    logger.info('Initializing database...');
    initDatabase();

    if (!isDatabaseInitialized()) {
      logger.info('Database not initialized. Running schema...');
      executeSchema();
      logger.info('✓ Database schema applied\n');
    } else {
      logger.info('✓ Database already initialized\n');
    }

    // Parse command line arguments
    const force = process.argv.includes('--force');

    if (force) {
      logger.info('⚠️  Force flag enabled - will sync regardless of cache freshness\n');
    }

    // Run ETL job
    const result = await runETLJob(force);

    // Print summary
    logger.info('\n');
    logger.info('Sync Summary');
    logger.info('============');
    logger.info(`Overall Success: ${result.success ? '✅' : '❌'}`);
    logger.info(`Duration: ${result.duration}ms\n`);

    logger.info('Listing:');
    logger.info(`  Success: ${result.listing.success ? '✅' : '❌'}`);
    if (result.listing.skipped) {
      logger.info('  Status: Skipped (cache fresh)');
    }
    if (result.listing.error) {
      logger.info(`  Error: ${result.listing.error}`);
    }

    logger.info('\nAvailability:');
    logger.info(`  Success: ${result.availability.success ? '✅' : '❌'}`);
    if (result.availability.skipped) {
      logger.info('  Status: Skipped (cache fresh)');
    }
    if (result.availability.daysCount) {
      logger.info(`  Days synced: ${result.availability.daysCount}`);
    }
    if (result.availability.error) {
      logger.info(`  Error: ${result.availability.error}`);
    }

    logger.info('\n');

    if (result.success) {
      logger.info('✅ Sync completed successfully!');
      process.exit(0);
    } else {
      logger.error('❌ Sync completed with errors');
      process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, 'Sync script failed');
    process.exit(1);
  }
}

main();