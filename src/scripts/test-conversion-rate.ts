/**
 * Test Conversion Rate Calculation
 */

import { getConversionRate } from '../repositories/availability-repository.js';
import { config } from '../config/index.js';
import { addMonths, format } from 'date-fns';
import { initDatabase } from '../db/index.js';

async function main() {
  console.log('\nTesting Conversion Rate Calculation');
  console.log('='.repeat(60));

  // Initialize database
  initDatabase();

  const threeMonthsAgo = addMonths(new Date(), -3);
  const today = new Date();

  const result = getConversionRate(
    config.guestyPropertyId,
    format(threeMonthsAgo, 'yyyy-MM-dd'),
    format(today, 'yyyy-MM-dd')
  );

  console.log('\n📊 Conversion Rate (Last 3 Months):');
  console.log('  Inquiries:', result.inquiriesCount);
  console.log('  Confirmed:', result.confirmedCount);
  console.log('  Conversion Rate:', result.conversionRate + '%');
  console.log('');
}

main();
