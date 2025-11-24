/**
 * Test All-Time Conversion Rate Calculation
 */

import { getAllTimeConversionRate } from '../repositories/availability-repository.js';
import { config } from '../config/index.js';
import { initDatabase } from '../db/index.js';

async function main() {
  console.log('\nTesting All-Time Conversion Rate Calculation');
  console.log('='.repeat(60));

  // Initialize database
  initDatabase();

  const result = getAllTimeConversionRate(config.guestyPropertyId);

  console.log('\n📊 All-Time Conversion Rate:');
  console.log('  Open Inquiries:', result.inquiriesCount);
  console.log('  Confirmed:', result.confirmedCount);
  console.log('  Declined:', result.declinedCount);
  console.log('  Canceled:', result.canceledCount);
  console.log('  Total Resolved:', result.confirmedCount + result.declinedCount + result.canceledCount);
  console.log('  Conversion Rate:', result.conversionRate + '%');
  console.log('');
}

main();
