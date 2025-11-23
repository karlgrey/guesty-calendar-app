/**
 * Debug Raw Reservation Response
 *
 * Fetch and display the raw JSON response from Guesty API
 */

import { config } from '../config/index.js';
import { guestyClient } from '../services/guesty-client.js';

async function main() {
  console.log('\nFetching Raw Reservations Data from Guesty');
  console.log('='.repeat(60));

  try {
    const reservations = await guestyClient.getReservations({
      listingId: config.guestyPropertyId,
      limit: 3,
    });

    console.log(`\nFound ${reservations.length} reservations\n`);

    reservations.forEach((r: any, index: number) => {
      console.log(`\nReservation ${index + 1}:`);
      console.log(JSON.stringify(r, null, 2));
      console.log('\n' + '='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
