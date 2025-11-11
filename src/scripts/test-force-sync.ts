/**
 * Test Force Sync
 *
 * Manually test the forced sync functionality
 */

import { initDatabase } from '../db/index.js';
import { runETLJob } from '../jobs/etl-job.js';
import logger from '../utils/logger.js';

async function testForceSync() {
  console.log('Testing Forced Sync Functionality');
  console.log('===================================\n');

  try {
    // Initialize database
    console.log('Step 1: Initializing database...');
    initDatabase();
    console.log('✅ Database initialized\n');

    // Run forced sync
    console.log('Step 2: Running forced sync (force=true)...');
    console.log('This will refresh all data from Guesty API, bypassing cache checks.\n');

    const result = await runETLJob(true);

    console.log('\nSync Results:');
    console.log('=============');
    console.log(`Overall Success: ${result.success ? '✅' : '❌'}`);
    console.log(`\nListing:`);
    console.log(`  - Success: ${result.listing.success ? '✅' : '❌'}`);
    console.log(`  - Skipped: ${result.listing.skipped ? 'Yes' : 'No'}`);
    if (result.listing.error) {
      console.log(`  - Error: ${result.listing.error}`);
    }
    console.log(`\nAvailability:`);
    console.log(`  - Success: ${result.availability.success ? '✅' : '❌'}`);
    console.log(`  - Days Synced: ${result.availability.daysCount || 0}`);
    console.log(`  - Skipped: ${result.availability.skipped ? 'Yes' : 'No'}`);
    if (result.availability.error) {
      console.log(`  - Error: ${result.availability.error}`);
    }
    console.log(`\nDuration: ${result.duration}ms`);

    console.log('\n✅ Force sync test completed!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error during force sync test:', error);
    process.exit(1);
  }
}

testForceSync();
