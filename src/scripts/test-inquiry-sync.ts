/**
 * Test Inquiry Sync
 *
 * Manual script to test syncing inquiries from Guesty API
 */

import { config } from '../config/index.js';
import { getDefaultProperty } from '../config/properties.js';
import { initDatabase } from '../db/index.js';
import { syncInquiries } from '../jobs/sync-inquiries.js';
import logger from '../utils/logger.js';

async function main() {
  console.log('\nTesting Inquiry Sync');
  console.log('='.repeat(60));

  try {
    // Initialize database
    console.log('\nStep 1: Initializing database...');
    initDatabase();
    console.log('✅ Database initialized');

    const defaultProperty = getDefaultProperty();
    const propertyId = config.guestyPropertyId || defaultProperty?.guestyPropertyId;

    if (!propertyId) {
      console.error('No property configured');
      process.exit(1);
    }

    // Sync inquiries
    console.log('\nStep 2: Syncing inquiries from Guesty...');
    const result = await syncInquiries(propertyId);

    if (result.success) {
      console.log('✅ Inquiry sync completed successfully!');
      console.log(`   - Inquiries: ${result.inquiriesCount}`);
      console.log(`   - Confirmed: ${result.confirmedCount}`);
    } else {
      console.log('❌ Inquiry sync failed:', result.error);
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
    logger.error({ error }, 'Inquiry sync test failed');
    process.exit(1);
  }
}

main();
