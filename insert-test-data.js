/**
 * Insert test availability data for calendar testing
 */

import Database from 'better-sqlite3';

const db = new Database('./data/calendar.db');

const listingId = '686d1e927ae7af00234115ad';
const today = new Date();

console.log('\n📅 Inserting test availability data...\n');

// Generate 90 days of test data
const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO availability (
    listing_id, date, status, price, min_nights,
    closed_to_arrival, closed_to_departure, block_type, block_ref, last_synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((days) => {
  for (const day of days) {
    insertStmt.run(
      day.listing_id,
      day.date,
      day.status,
      day.price,
      day.min_nights,
      day.closed_to_arrival ? 1 : 0,
      day.closed_to_departure ? 1 : 0,
      day.block_type,
      day.block_ref,
      day.last_synced_at
    );
  }
});

const testData = [];
for (let i = 0; i < 90; i++) {
  const date = new Date(today);
  date.setDate(date.getDate() + i);
  const dateStr = date.toISOString().split('T')[0];

  // Make some days booked (every 7th and 8th day)
  const isBooked = (i % 10 === 7 || i % 10 === 8);

  // Weekend pricing (Fri-Sun)
  const dayOfWeek = date.getDay();
  const isWeekend = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;
  const price = isWeekend ? 1800 : 1500;

  testData.push({
    listing_id: listingId,
    date: dateStr,
    status: isBooked ? 'booked' : 'available',
    price: isBooked ? 0 : price,
    min_nights: isWeekend ? 2 : 1,
    closed_to_arrival: false,
    closed_to_departure: false,
    block_type: isBooked ? 'reservation' : null,
    block_ref: isBooked ? `test-booking-${i}` : null,
    last_synced_at: new Date().toISOString()
  });
}

insertMany(testData);

const count = db.prepare('SELECT COUNT(*) as count FROM availability').get();
console.log(`✅ Inserted ${testData.length} days of test availability data`);
console.log(`📊 Total records in database: ${count.count}`);

// Show sample
console.log('\n📋 Sample data:');
const sample = db.prepare(`
  SELECT date, status, price, min_nights
  FROM availability
  WHERE listing_id = ?
  ORDER BY date
  LIMIT 10
`).all(listingId);

sample.forEach(row => {
  console.log(`  ${row.date}: ${row.status.padEnd(10)} €${row.price} (min ${row.min_nights} nights)`);
});

console.log('\n✅ Test data ready! Visit http://localhost:3000 to see the calendar.\n');

db.close();