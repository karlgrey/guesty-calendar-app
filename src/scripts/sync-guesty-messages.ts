/**
 * Manual sync of Guesty conversations for a property.
 *
 * Usage:
 *   npx tsx src/scripts/sync-guesty-messages.ts <slug>
 *
 * Example:
 *   npx tsx src/scripts/sync-guesty-messages.ts farmhouse
 */

import { initDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import { syncGuestyMessagesForProperty } from '../jobs/sync-guesty-messages.js';
import { getCategoryCounts, countThreads } from '../repositories/message-repository.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: sync-guesty-messages.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }
  if (property.provider !== 'guesty') {
    console.error(`Property '${slug}' has provider='${property.provider}', not 'guesty'. Skipping.`);
    process.exit(1);
  }

  initDatabase();
  const result = await syncGuestyMessagesForProperty(property);
  console.log('\n=== Sync result ===');
  console.log(JSON.stringify(result, null, 2));

  if (result.success && property.guestyPropertyId) {
    console.log('\n=== DB state for', property.guestyPropertyId, '===');
    console.log('total threads:', countThreads(property.guestyPropertyId));
    console.log('by category:', getCategoryCounts(property.guestyPropertyId));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
