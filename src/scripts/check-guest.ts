import { guestyClient } from '../services/guesty-client.js';

async function main() {
  const guestId = process.argv[2] || '691201e1066b5982702c39c3';
  const guest = await guestyClient.getGuest(guestId);
  console.log('Guest address data:');
  console.log(JSON.stringify(guest.address, null, 2));
  console.log('\nGuest name fields:');
  console.log('firstName:', guest.firstName);
  console.log('lastName:', guest.lastName);
  console.log('fullName:', guest.fullName);
  console.log('company:', guest.company);
}

main();
