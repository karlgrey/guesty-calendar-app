/**
 * Debug Raw Reservation Response
 *
 * Fetch and display the raw JSON response from Guesty API
 */

import { guestyClient } from '../services/guesty-client.js';

async function main() {
  console.log('\nFetching Raw Reservations Data from Guesty');
  console.log('='.repeat(60));

  try {
    console.log('\n📋 Test 1: Fetch ALL reservations (no listingId filter)');
    console.log('-'.repeat(60));

    const allReservations = await guestyClient.getReservations({
      limit: 100,
    });

    console.log(`\nFound ${allReservations.length} total reservations\n`);

    // Group by status
    const byStatus = allReservations.reduce((acc: any, r: any) => {
      const status = r.status || 'unknown';
      if (!acc[status]) acc[status] = [];
      acc[status].push(r);
      return acc;
    }, {});

    console.log('📊 Reservations by status:');
    Object.keys(byStatus).forEach(status => {
      console.log(`  ${status}: ${byStatus[status].length}`);
    });

    console.log('\n📋 Test 2: Show first inquiry (if any)');
    console.log('-'.repeat(60));

    const inquiries = allReservations.filter((r: any) => r.status === 'inquiry');
    if (inquiries.length > 0) {
      const inquiry = inquiries[0];
      console.log('First inquiry found:');
      console.log('  _id:', inquiry._id);
      console.log('  status:', inquiry.status);
      console.log('  checkIn:', inquiry.checkIn);
      console.log('  checkOut:', inquiry.checkOut);
      console.log('  guest:', inquiry.guest?.fullName);
      console.log('  guestsCount:', inquiry.guestsCount);
      console.log('  source:', inquiry.source);
      console.log('  createdAt:', inquiry.createdAt);
      console.log('  listingId:', inquiry.listingId);
    } else {
      console.log('❌ No inquiries found in API response');
      console.log('This might mean:');
      console.log('  1. All inquiries are in a different account/property');
      console.log('  2. The API requires additional filters');
      console.log('  3. Inquiries need special API permissions');
    }

    console.log('\n📋 Test 2: Check what we have in database from calendar endpoint');
    console.log('-'.repeat(60));
    console.log('We already have this data from calendar endpoint:');
    console.log('  - 21 confirmed bookings');
    console.log('  - 1 reserved booking');
    console.log('  - 0 inquiry status bookings');
    console.log('  - 0 canceled/declined bookings');

  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
