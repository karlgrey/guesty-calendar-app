/**
 * Manual Airbnb-Mail Sync Test
 *
 * Usage:
 *   npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>
 */

import { getPropertyBySlug } from '../config/properties.js';
import { runETLJobForProperty } from '../jobs/etl-job.js';
import { getDatabase, initDatabase } from '../db/index.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: test-airbnb-mail-sync.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found in properties.json`);
    process.exit(1);
  }
  if (property.provider !== 'airbnb-mail') {
    console.error(`Property '${slug}' is not provider=airbnb-mail (got: ${property.provider})`);
    process.exit(1);
  }

  initDatabase();
  const result = await runETLJobForProperty(property, true);
  console.log('\n=== ETL Result ===');
  console.log(JSON.stringify(result, null, 2));

  const db = getDatabase();
  const id = property.airbnbListingId!;
  console.log('\n=== DB Sanity ===');
  console.log('listing:', db.prepare('SELECT id, title, accommodates, base_price FROM listings WHERE id = ?').get(id));
  console.log('reservations:', db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE listing_id = ?').get(id));
  console.log('inquiries:', db.prepare('SELECT COUNT(*) AS n FROM inquiries WHERE listing_id = ?').get(id));
  console.log('availability:', db.prepare('SELECT COUNT(*) AS n FROM availability WHERE listing_id = ?').get(id));
  console.log('mail archive (by status):',
    db.prepare(`SELECT parse_status, COUNT(*) AS n FROM airbnb_mail_archive WHERE property_slug = ? GROUP BY parse_status`).all(slug));
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
