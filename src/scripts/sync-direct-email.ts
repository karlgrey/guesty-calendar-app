/**
 * Sync direct-booking emails from the property's Gmail label.
 *
 * Usage:
 *   npx tsx src/scripts/sync-direct-email.ts <slug>
 *
 * Example:
 *   npx tsx src/scripts/sync-direct-email.ts farmhouse
 */

import { initDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import { syncDirectEmailMessagesForProperty } from '../jobs/sync-direct-email-messages.js';
import { getCategoryCounts, countThreads } from '../repositories/message-repository.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: sync-direct-email.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }
  if (!property.directEmailLabel) {
    console.error(`Property '${slug}' has no directEmailLabel configured`);
    process.exit(1);
  }

  initDatabase();
  console.log(`Syncing direct emails for ${property.name} (label: ${property.directEmailLabel})…`);
  const result = await syncDirectEmailMessagesForProperty(property);
  console.log('\n=== Sync result ===');
  console.log(JSON.stringify(result, null, 2));

  const listingId =
    property.guestyPropertyId ?? property.hostexPropertyId ?? property.airbnbListingId;
  if (result.success && listingId) {
    console.log('\n=== DB state for listing', listingId, '===');
    console.log('total threads:', countThreads(listingId));
    console.log('by category:', getCategoryCounts(listingId));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
