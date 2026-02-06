/**
 * Test Conversion Rate Calculation
 */

import { getConversionRate } from '../repositories/availability-repository.js';
import { config } from '../config/index.js';
import { getDefaultProperty } from '../config/properties.js';
import { addMonths, format } from 'date-fns';
import { initDatabase } from '../db/index.js';

async function main() {
  console.log('\nTesting Conversion Rate Calculation');
  console.log('='.repeat(60));

  // Initialize database
  initDatabase();

  const defaultProperty = getDefaultProperty();
  const propertyId = config.guestyPropertyId || defaultProperty?.guestyPropertyId;

  if (!propertyId) {
    console.error('No property configured');
    process.exit(1);
  }

  const threeMonthsAgo = addMonths(new Date(), -3);
  const today = new Date();

  const result = getConversionRate(
    propertyId,
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
