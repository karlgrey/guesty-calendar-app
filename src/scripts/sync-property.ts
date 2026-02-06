import { initDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import { runETLJobForProperty } from '../jobs/etl-job.js';

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: npx tsx src/scripts/sync-property.ts <slug>');
  process.exit(1);
}

const property = getPropertyBySlug(slug);
if (!property) {
  console.error(`Property '${slug}' not found`);
  process.exit(1);
}

initDatabase();
console.log(`\nSyncing property: ${property.name} (${slug})...\n`);

const result = await runETLJobForProperty(property, true);
console.log('\nResult:', JSON.stringify(result, null, 2));
