import { guestyClient } from '../services/guesty-client.js';

async function main() {
  const reservationId = process.argv[2] || '692d57faaeac79b9c517e8c4';
  const reservation = await guestyClient.getReservation(reservationId);
  
  console.log('=== Reservation Notes ===');
  console.log('Guest:', reservation.guest?.fullName);
  console.log('');
  console.log('guestNote:', reservation.guestNote);
  console.log('note:', reservation.note);
  console.log('notes:', reservation.notes);
  console.log('guestNotes:', reservation.guestNotes);
  console.log('notesForGuests:', reservation.notesForGuests);
  console.log('customFields:', JSON.stringify(reservation.customFields, null, 2));
  console.log('');
  console.log('=== Money / Discounts ===');
  console.log('fareAccommodation:', reservation.money?.fareAccommodation);
  console.log('fareAccommodationAdjusted:', reservation.money?.fareAccommodationAdjusted);
  console.log('fareAccommodationDiscount:', reservation.money?.fareAccommodationDiscount);
  console.log('subTotalPrice:', reservation.money?.subTotalPrice);
  console.log('hostPayout:', reservation.money?.hostPayout);
}

main();
