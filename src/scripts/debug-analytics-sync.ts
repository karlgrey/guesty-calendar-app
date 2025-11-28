/**
 * Debug Analytics Sync
 *
 * Debug script to identify issues with the analytics sync.
 */

import { ga4Client } from '../services/ga4-client.js';
import { initDatabase } from '../db/index.js';
import {
  upsertDailyAnalyticsBatch,
  replaceTopPages,
  logSync,
  getAnalyticsSummary,
  getLatestTopPages,
} from '../repositories/analytics-repository.js';

// Initialize database
initDatabase();

async function debug() {
  console.log('='.repeat(60));
  console.log('Debugging Analytics Sync');
  console.log('='.repeat(60));

  try {
    // Step 1: Fetch from GA4
    console.log('\n1. Fetching analytics from GA4...');
    const analytics = await ga4Client.getAnalytics(30);
    console.log(`   ✅ Fetched ${analytics.dailyData.length} days of data`);
    console.log(`   Sample: ${JSON.stringify(analytics.dailyData[0])}`);

    // Step 2: Insert daily data
    console.log('\n2. Inserting daily analytics into database...');
    try {
      const recordsSynced = upsertDailyAnalyticsBatch(analytics.dailyData);
      console.log(`   ✅ Inserted ${recordsSynced} records`);
    } catch (error) {
      console.error('   ❌ Failed to insert daily data:', error);
      throw error;
    }

    // Step 3: Insert top pages
    console.log('\n3. Inserting top pages...');
    try {
      const today = new Date().toISOString().split('T')[0];
      replaceTopPages(today, analytics.topPages);
      console.log(`   ✅ Inserted ${analytics.topPages.length} top pages for ${today}`);
    } catch (error) {
      console.error('   ❌ Failed to insert top pages:', error);
      throw error;
    }

    // Step 4: Log the sync
    console.log('\n4. Logging sync...');
    try {
      logSync(analytics.startDate, analytics.endDate, analytics.dailyData.length, true);
      console.log('   ✅ Sync logged');
    } catch (error) {
      console.error('   ❌ Failed to log sync:', error);
      throw error;
    }

    // Step 5: Verify data
    console.log('\n5. Verifying data in database...');
    const summary = getAnalyticsSummary(30);
    const topPages = getLatestTopPages();
    console.log(`   Summary: ${JSON.stringify(summary)}`);
    console.log(`   Top pages: ${topPages.length} records`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ All steps completed successfully!');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\n❌ Debug failed:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

debug();
