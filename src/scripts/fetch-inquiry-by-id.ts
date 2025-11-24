/**
 * Fetch a specific inquiry by ID
 */

import { guestyClient } from '../services/guesty-client.js';

async function main() {
  const inquiryId = '6910d0a12f0c110013be4656';

  console.log('\nFetching Inquiry from Guesty API');
  console.log('='.repeat(60));
  console.log(`Inquiry ID: ${inquiryId}\n`);

  try {
    // Fetch the specific inquiry
    const response = await guestyClient['request'](`/reservations/${inquiryId}`);

    console.log('✅ Successfully fetched inquiry!\n');
    console.log('Full inquiry data:');
    console.log(JSON.stringify(response, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('Key fields:');
    console.log('  _id:', response._id);
    console.log('  status:', response.status);
    console.log('  checkIn:', response.checkIn);
    console.log('  checkOut:', response.checkOut);
    console.log('  guest:', response.guest?.fullName);
    console.log('  guestsCount:', response.guestsCount);
    console.log('  source:', response.source);
    console.log('  createdAt:', response.createdAt);
    console.log('  listingId:', response.listingId);
    console.log('  confirmationCode:', response.confirmationCode);

  } catch (error) {
    console.error('❌ Failed to fetch inquiry:', error);
    process.exit(1);
  }
}

main();
