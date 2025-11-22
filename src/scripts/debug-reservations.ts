/**
 * Debug Reservations
 *
 * Fetch and display raw reservation data from Guesty API
 */

import { config } from '../config/index.js';
import { guestyClient } from '../services/guesty-client.js';

async function main() {
  console.log('\nFetching Reservations from Guesty');
  console.log('='.repeat(60));

  try {
    const reservations = await guestyClient.getReservations({
      listingId: config.guestyPropertyId,
      limit: 10,
    });

    console.log(`\nFound ${reservations.length} reservations\n`);

    reservations.forEach((r: any, index: number) => {
      console.log(`Reservation ${index + 1}:`);
      console.log(`  ID: ${r._id}`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Check-in: ${r.checkIn}`);
      console.log(`  Check-out: ${r.checkOut}`);
      console.log(`  Guest: ${r.guest?.firstName} ${r.guest?.lastName}`);
      console.log(`  Guests count: ${r.guestsCount}`);
      console.log(`  Source: ${r.source}`);
      console.log(`  Created: ${r.createdAt}`);
      console.log('');
    });
  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
