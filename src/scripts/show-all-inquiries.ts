/**
 * Show All Inquiries Data
 *
 * Displays all inquiries from the database with their current status
 */

import { getDatabase, initDatabase } from '../db/index.js';
import { config } from '../config/index.js';

async function main() {
  console.log('\nAll Inquiries/Reservations in Database');
  console.log('='.repeat(60));

  // Initialize database first
  initDatabase();

  const db = getDatabase();

  // Get all inquiries grouped by status
  const allInquiries = db
    .prepare(
      `SELECT
        inquiry_id,
        status,
        check_in,
        check_out,
        guest_name,
        guests_count,
        source,
        created_at_guesty,
        last_synced_at
      FROM inquiries
      WHERE listing_id = ?
      ORDER BY created_at_guesty DESC`
    )
    .all(config.guestyPropertyId);

  console.log(`\nTotal records: ${allInquiries.length}\n`);

  // Group by status
  const byStatus: Record<string, any[]> = {};
  for (const inquiry of allInquiries) {
    const status = (inquiry as any).status;
    if (!byStatus[status]) {
      byStatus[status] = [];
    }
    byStatus[status].push(inquiry);
  }

  // Display counts by status
  console.log('📊 Count by Status:');
  for (const [status, items] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${items.length}`);
  }

  // Display each status group
  for (const [status, items] of Object.entries(byStatus)) {
    console.log('\n' + '='.repeat(60));
    console.log(`${status.toUpperCase()} (${items.length} records)`);
    console.log('='.repeat(60));

    for (const item of items) {
      const i = item as any;
      console.log(`\nID: ${i.inquiry_id}`);
      console.log(`  Guest: ${i.guest_name}`);
      console.log(`  Check-in: ${i.check_in}`);
      console.log(`  Check-out: ${i.check_out}`);
      console.log(`  Guests: ${i.guests_count}`);
      console.log(`  Source: ${i.source || 'N/A'}`);
      console.log(`  Created: ${i.created_at_guesty}`);
    }
  }
}

main();
