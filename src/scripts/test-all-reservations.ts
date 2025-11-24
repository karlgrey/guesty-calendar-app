/**
 * Test fetching ALL reservations (not filtered by listingId)
 */

import { guestyClient } from '../services/guesty-client.js';
import { config } from '../config/index.js';

async function main() {
  console.log('\nTesting All Reservations Fetch');
  console.log('='.repeat(60));

  try {
    // Test 1: Fetch with listingId filter (current approach)
    console.log('\n📋 Test 1: Fetch with listingId filter');
    console.log('-'.repeat(60));

    const withListingId = await guestyClient.getReservations({
      listingId: config.guestyPropertyId,
      limit: 1000,
    });

    console.log(`  Total reservations: ${withListingId.length}`);

    // Count by status
    const statusCounts: Record<string, number> = {};
    withListingId.forEach((r: any) => {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    });

    console.log('  Status breakdown:');
    Object.entries(statusCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        console.log(`    ${status}: ${count}`);
      });

    // Test 2: Fetch WITHOUT listingId filter
    console.log('\n📋 Test 2: Fetch WITHOUT listingId filter');
    console.log('-'.repeat(60));

    const withoutListingId = await guestyClient.getReservations({
      limit: 1000,
    });

    console.log(`  Total reservations: ${withoutListingId.length}`);

    // Count by status
    const statusCounts2: Record<string, number> = {};
    withoutListingId.forEach((r: any) => {
      statusCounts2[r.status] = (statusCounts2[r.status] || 0) + 1;
    });

    console.log('  Status breakdown:');
    Object.entries(statusCounts2)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        console.log(`    ${status}: ${count}`);
      });

    // Count how many have our listingId
    const forOurListing = withoutListingId.filter((r: any) =>
      r.listingId === config.guestyPropertyId
    );
    console.log(`  Reservations for our listing: ${forOurListing.length}`);

    // Test 3: Fetch with higher limit
    console.log('\n📋 Test 3: Fetch with limit=100 (see if API returns more)');
    console.log('-'.repeat(60));

    const higherLimit = await guestyClient.getReservations({
      listingId: config.guestyPropertyId,
      limit: 100,
    });

    console.log(`  Total reservations: ${higherLimit.length}`);

    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log(`  With listingId filter: ${withListingId.length} reservations`);
    console.log(`  Without listingId filter: ${withoutListingId.length} reservations`);
    console.log(`  For our listing (no filter): ${forOurListing.length} reservations`);
    console.log(`  With limit=100: ${higherLimit.length} reservations`);
    console.log('');

  } catch (error) {
    console.error('❌ Failed to fetch reservations:', error);
    process.exit(1);
  }
}

main();
