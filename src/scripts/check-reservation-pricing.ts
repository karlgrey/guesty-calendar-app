import { guestyClient } from '../services/guesty-client.js';

async function main() {
  const reservationId = process.argv[2] || '691201e1a4e56a8196df5689';
  const reservation = await guestyClient.getReservation(reservationId);
  
  console.log('=== Reservation Pricing ===');
  console.log('Confirmation Code:', reservation.confirmationCode);
  console.log('Guest:', reservation.guest?.fullName);
  console.log('Check-in:', reservation.checkInDateLocalized);
  console.log('Check-out:', reservation.checkOutDateLocalized);
  console.log('Nights:', reservation.nightsCount);
  console.log('Guests:', reservation.guestsCount);
  console.log('');
  console.log('=== Money Fields ===');
  console.log('totalPrice:', reservation.totalPrice);
  console.log('totalPaid:', reservation.totalPaid);
  console.log('balance:', reservation.balance);
  console.log('');
  console.log('=== Money Object ===');
  console.log(JSON.stringify(reservation.money, null, 2));
  console.log('');
  console.log('=== Integration ===');
  console.log('Source:', reservation.source);
  console.log('Integration:', reservation.integration?.platform);
}

main();
