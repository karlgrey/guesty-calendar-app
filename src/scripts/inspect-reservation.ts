/**
 * Inspect reservation money object from Guesty
 * Usage: npx tsx src/scripts/inspect-reservation.ts <reservationId>
 */

import { guestyClient } from '../services/guesty-client.js';
import { initDatabase } from '../db/index.js';

async function main() {
  const reservationId = process.argv[2];

  if (!reservationId) {
    console.error('Usage: npx tsx src/scripts/inspect-reservation.ts <reservationId>');
    process.exit(1);
  }

  initDatabase();

  console.log(`\nFetching reservation: ${reservationId}\n`);

  const reservation = await guestyClient.getReservation(reservationId);
  const money = reservation.money;

  console.log('=== RESERVATION INFO ===');
  console.log('Source:', reservation.source);
  console.log('Integration:', reservation.integration?.platform);
  console.log('Check-in:', reservation.checkIn);
  console.log('Check-out:', reservation.checkOut);
  console.log('Guests:', reservation.guestsCount);
  console.log('');

  console.log('=== MAIN AMOUNTS ===');
  console.log('fareAccommodation (original):', money.fareAccommodation);
  console.log('fareAccommodationAdjusted:', money.fareAccommodationAdjusted);
  console.log('fareCleaning:', money.fareCleaning);
  console.log('subTotalPrice:', money.subTotalPrice);
  console.log('totalTaxes:', money.totalTaxes);
  console.log('totalPrice:', money.totalPrice);
  console.log('');

  console.log('=== FEES & COMMISSIONS ===');
  console.log('hostServiceFee:', money.hostServiceFee);
  console.log('hostServiceFeeIncTax:', money.hostServiceFeeIncTax);
  console.log('channelCommission:', money.channelCommission);
  console.log('');

  console.log('=== PAYOUT ===');
  console.log('hostPayout:', money.hostPayout);
  console.log('balanceDue:', money.balanceDue);
  console.log('');

  console.log('=== INVOICE ITEMS ===');
  if (money.invoiceItems) {
    money.invoiceItems.forEach((item: any, i: number) => {
      console.log(`[${i}] normalType: ${item.normalType}, title: "${item.title}", amount: ${item.amount}, baseAmount: ${item.baseAmount}`);
    });
  }
  console.log('');

  console.log('=== CALCULATION CHECK ===');
  const accommodation = money.fareAccommodation || 0;
  const cleaning = money.fareCleaning || 0;
  const taxes = money.totalTaxes || 0;
  const hostFee = money.hostServiceFee || 0;
  const channelComm = money.channelCommission || 0;

  console.log(`Accommodation + Cleaning = ${accommodation} + ${cleaning} = ${accommodation + cleaning}`);
  console.log(`+ Taxes (${taxes}) = ${accommodation + cleaning + taxes}`);
  console.log(`- Host Service Fee (${hostFee}) = ${accommodation + cleaning + taxes - hostFee}`);
  console.log(`- Channel Commission (${channelComm}) = ${accommodation + cleaning + taxes - hostFee - channelComm}`);
  console.log(`hostPayout from Guesty: ${money.hostPayout}`);
}

main().catch(console.error);
