/**
 * Manual Hostex Sync Test
 *
 * Usage:
 *   npx tsx src/scripts/test-hostex-sync.ts <slug>
 *
 * Runs the full Hostex ETL pipeline for one configured property,
 * shows the result, and prints a quick sanity-check of the DB rows.
 */

import { getPropertyBySlug } from '../config/properties.js';
import { runETLJobForProperty } from '../jobs/etl-job.js';
import { getDatabase, initDatabase } from '../db/index.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: test-hostex-sync.ts <slug>');
    process.exit(1);
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found in properties.json`);
    process.exit(1);
  }
  if (property.provider !== 'hostex') {
    console.error(`Property '${slug}' is not a Hostex property (provider=${property.provider})`);
    process.exit(1);
  }

  initDatabase();
  const result = await runETLJobForProperty(property, true);
  console.log('\n=== ETL Result ===');
  console.log(JSON.stringify(result, null, 2));

  const db = getDatabase();
  const listing = db
    .prepare('SELECT * FROM listings WHERE id = ?')
    .get(property.hostexPropertyId);
  const reservations = db
    .prepare('SELECT COUNT(*) AS n FROM reservations WHERE listing_id = ?')
    .get(property.hostexPropertyId);
  const inquiries = db
    .prepare('SELECT COUNT(*) AS n FROM inquiries WHERE listing_id = ?')
    .get(property.hostexPropertyId);
  const availability = db
    .prepare('SELECT COUNT(*) AS n FROM availability WHERE listing_id = ?')
    .get(property.hostexPropertyId);

  console.log('\n=== DB Sanity Check ===');
  console.log('listing:', listing ? '✓' : '✗');
  console.log('reservations count:', reservations);
  console.log('inquiries count:', inquiries);
  console.log('availability count:', availability);
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
