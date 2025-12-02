#!/usr/bin/env npx tsx
/**
 * Debug script to check reservation pricing from Guesty API
 */

import { guestyClient } from '../services/guesty-client.js';

const reservationId = process.argv[2];

if (!reservationId) {
  console.error('Usage: npx tsx src/scripts/check-reservation.ts <reservationId>');
  process.exit(1);
}

async function check() {
  const res = await guestyClient.getReservation(reservationId);
  console.log('Guest:', res.guest?.fullName);
  console.log('Guests count:', res.guestsCount);
  console.log('Nights:', res.nightsCount);
  console.log('\nMoney:');
  console.log('  fareAccommodation:', res.money?.fareAccommodation);
  console.log('  fareAccommodationAdjusted:', res.money?.fareAccommodationAdjusted);
  console.log('  fareCleaning:', res.money?.fareCleaning);
  console.log('  hostPayout:', res.money?.hostPayout);
  console.log('  totalTaxes:', res.money?.totalTaxes);
  console.log('  subTotalPrice:', res.money?.subTotalPrice);
  console.log('  balanceDue:', res.money?.balanceDue);

  console.log('\nInvoice Items:');
  for (const item of (res.money as any)?.invoiceItems || []) {
    console.log('  -', item.normalType || item.type, ':', item.amount, '(base:', item.baseAmount, ')');
  }

  console.log('\nSettings Snapshot:');
  const settings = (res.money as any)?.settingsSnapshot;
  if (settings) {
    console.log('  guestsIncludedInRegularFee:', settings.guestsIncludedInRegularFee);
    console.log('  extraPersonFee:', settings.extraPersonFee);
  }
}

check().catch(console.error);
