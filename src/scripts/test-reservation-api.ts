/**
 * Test Calendar API for Reservation Data
 *
 * Check what reservation details are available in the calendar API blockRefs
 */

import { guestyClient } from '../services/guesty-client.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

async function main() {
  try {
    // Fetch calendar data for a date range that includes bookings
    const today = new Date();
    const startDate = today.toISOString().split('T')[0];
    const endDate = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    logger.info({ startDate, endDate }, 'Fetching calendar data...');

    const calendar = await guestyClient.getCalendar(config.guestyPropertyId, startDate, endDate);

    // Find days with blockRefs (booked/blocked days)
    const daysWithBlocks = calendar.filter(day =>
      day.blockRefs &&
      day.blockRefs.length > 0 &&
      day.blockRefs.some(ref => ref.reservationId)
    );

    console.log(`\n=== FOUND ${daysWithBlocks.length} DAYS WITH BOOKINGS ===\n`);

    if (daysWithBlocks.length > 0) {
      const firstBlock = daysWithBlocks[0];
      console.log('=== SAMPLE CALENDAR DAY WITH BOOKING ===');
      console.log(JSON.stringify(firstBlock, null, 2));

      const bookingRef = firstBlock.blockRefs?.find(ref => ref.reservationId);
      if (bookingRef) {
        console.log('\n=== BOOKING BLOCK REF FIELDS ===');
        console.log(Object.keys(bookingRef).sort().join('\n'));

        if (bookingRef.reservation) {
          console.log('\n=== RESERVATION OBJECT ===');
          console.log(JSON.stringify(bookingRef.reservation, null, 2));
          console.log('\n=== RESERVATION FIELDS ===');
          console.log(Object.keys(bookingRef.reservation).sort().join('\n'));
        } else {
          console.log('\n❌ No reservation object found in blockRef');
          console.log('But we have reservationId:', bookingRef.reservationId);
        }
      }
    } else {
      console.log('❌ No booked days found in the calendar');
    }

  } catch (error) {
    logger.error({ error }, 'Failed to fetch calendar data');
  }
}

main();
