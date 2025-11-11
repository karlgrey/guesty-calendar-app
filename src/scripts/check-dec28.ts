import { initDatabase, getDatabase } from '../db/index.js';
import { config } from '../config/index.js';

initDatabase();
const db = getDatabase();

console.log('Checking Dec 27-28 reservation status...\n');

const reservations = db.prepare(`
  SELECT reservation_id, check_in, check_out, guest_name, status
  FROM reservations
  WHERE check_in BETWEEN '2025-12-27' AND '2025-12-28'
`).all();

if (reservations.length === 0) {
  console.log('✅ No reservations found for Dec 27-28 (cancelled reservation was deleted!)');
} else {
  console.log(`Found ${reservations.length} reservation(s):`);
  for (const res of reservations as any[]) {
    console.log(`  - ${res.guest_name}: ${res.check_in} to ${res.check_out} (${res.status})`);
  }
}
