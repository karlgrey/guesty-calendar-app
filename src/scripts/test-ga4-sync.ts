/**
 * Test GA4 Analytics Sync
 *
 * Manually tests the GA4 analytics sync functionality.
 * Usage: npx tsx src/scripts/test-ga4-sync.ts
 */

import { ga4Client } from '../services/ga4-client.js';
import { initDatabase } from '../db/index.js';
import { syncAnalytics } from '../jobs/sync-analytics.js';
import { getAnalyticsSummary, getLatestTopPages } from '../repositories/analytics-repository.js';
import logger from '../utils/logger.js';

// Initialize database
initDatabase();

async function testGA4Sync() {
  console.log('='.repeat(60));
  console.log('Testing GA4 Analytics Integration');
  console.log('='.repeat(60));

  // Check if GA4 is enabled
  console.log('\n1. Checking GA4 configuration...');
  const isEnabled = ga4Client.isEnabled();
  console.log(`   GA4 Enabled: ${isEnabled}`);

  if (!isEnabled) {
    console.log('\n❌ GA4 is not enabled. Please configure the following in .env:');
    console.log('   - GA4_ENABLED=true');
    console.log('   - GA4_PROPERTY_ID=your_property_id');
    console.log('   - GA4_KEY_FILE_PATH=./data/ga4-service-account.json');
    process.exit(1);
  }

  // Test connection
  console.log('\n2. Testing GA4 connection...');
  const connectionTest = await ga4Client.testConnection();

  if (!connectionTest.success) {
    console.log(`\n❌ Connection test failed: ${connectionTest.error}`);
    console.log('\nPlease check:');
    console.log('   - Service account JSON key file exists');
    console.log('   - Service account has Viewer access to the GA4 property');
    console.log('   - GA4 Property ID is correct');
    process.exit(1);
  }

  console.log('   ✅ Connection successful!');

  // Fetch analytics directly from GA4
  console.log('\n3. Fetching analytics from GA4...');
  try {
    const analytics = await ga4Client.getAnalytics(30);

    console.log('\n   Summary (last 30 days):');
    console.log(`   - Pageviews: ${analytics.totalPageviews.toLocaleString()}`);
    console.log(`   - Users: ${analytics.totalUsers.toLocaleString()}`);
    console.log(`   - Sessions: ${analytics.totalSessions.toLocaleString()}`);
    console.log(`   - Avg. Session Duration: ${Math.round(analytics.avgSessionDuration)}s`);
    console.log(`   - Days with data: ${analytics.dailyData.length}`);

    console.log('\n   Top 5 Pages:');
    analytics.topPages.slice(0, 5).forEach((page, i) => {
      console.log(`   ${i + 1}. ${page.pagePath} - ${page.pageviews} views`);
    });
  } catch (error) {
    console.log(`\n❌ Failed to fetch analytics: ${error}`);
    process.exit(1);
  }

  // Sync to database
  console.log('\n4. Syncing analytics to database...');
  const syncResult = await syncAnalytics(30);

  if (!syncResult.success) {
    console.log(`\n❌ Sync failed: ${syncResult.error}`);
    process.exit(1);
  }

  console.log(`   ✅ Synced ${syncResult.recordsSynced} records in ${syncResult.durationMs}ms`);

  // Verify data in database
  console.log('\n5. Verifying data in database...');
  const summary = getAnalyticsSummary(30);
  const topPages = getLatestTopPages();

  console.log('\n   Database Summary:');
  console.log(`   - Pageviews: ${summary.totalPageviews.toLocaleString()}`);
  console.log(`   - Users: ${summary.totalUsers.toLocaleString()}`);
  console.log(`   - Sessions: ${summary.totalSessions.toLocaleString()}`);
  console.log(`   - Days with data: ${summary.daysWithData}`);

  console.log(`\n   Top Pages in DB: ${topPages.length} records`);

  console.log('\n' + '='.repeat(60));
  console.log('✅ GA4 Analytics integration test completed successfully!');
  console.log('='.repeat(60));
}

testGA4Sync().catch((error) => {
  logger.error({ error }, 'Test failed');
  process.exit(1);
});
