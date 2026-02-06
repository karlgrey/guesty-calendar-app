/**
 * Sync 60 days of GA4 data
 */
import { ga4Client } from '../services/ga4-client.js';
import { initDatabase } from '../db/index.js';
import { upsertDailyAnalyticsBatch, replaceRegions } from '../repositories/analytics-repository.js';

initDatabase();

async function sync60Days() {
  console.log('Syncing 60 days of GA4 data...');
  const analytics = await ga4Client.getAnalytics(60);
  console.log(`Fetched ${analytics.dailyData.length} days of data`);

  const count = upsertDailyAnalyticsBatch(analytics.dailyData);
  console.log(`Synced ${count} records`);

  // Also sync regions
  const today = new Date().toISOString().split('T')[0];
  if (analytics.topRegions.length > 0) {
    replaceRegions(today, analytics.topRegions);
    console.log(`Synced ${analytics.topRegions.length} regions`);
  }

  // Show December data
  console.log('\nDecember data check:');
  const { getAnalyticsRange } = await import('../repositories/analytics-repository.js');
  const decData = getAnalyticsRange('2025-12-01', '2025-12-31');
  console.log(`December has ${decData.length} days of data`);
  decData.forEach(d => console.log(`  ${d.date}: ${d.users} visitors`));
}

sync60Days().catch(console.error);
