/**
 * Re-run the conversation classifier over already-stored messages.
 *
 * Re-classifies every auto-categorized thread of a property using the current
 * classifier rules — no Guesty-API / IMAP calls. Threads with a manual override
 * (manually_categorized = 1) are left untouched.
 *
 * Usage:
 *   npx tsx src/scripts/reclassify-threads.ts <slug>
 */

import { initDatabase } from '../db/index.js';
import { getPropertyBySlug, getListingId } from '../config/properties.js';
import {
  getThreadsByListing,
  getMessagesByThread,
  updateThreadClassification,
  getCategoryCounts,
} from '../repositories/message-repository.js';
import { classifyThread } from '../utils/message-classifier.js';

function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: reclassify-threads.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  initDatabase();
  let listingId: string;
  try {
    listingId = getListingId(property);
  } catch (e) {
    console.error(
      `No listing id resolvable for '${slug}':`,
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  }

  const before = getCategoryCounts(listingId);
  // limit: fetch all threads — no pagination needed for a one-shot CLI
  const threads = getThreadsByListing(listingId, { limit: 100000 });

  let updated = 0;
  let skippedManual = 0;
  for (const thread of threads) {
    if (thread.manually_categorized === 1) {
      skippedManual++;
      continue;
    }
    const messages = getMessagesByThread(thread.id).map((m) => ({
      direction: m.direction,
      body: m.body ?? '',
    }));
    const result = classifyThread({
      reservationStatus: thread.reservation_status,
      channel: thread.channel,
      messages,
    });
    updateThreadClassification(
      thread.id,
      result.category,
      result.confidence,
      JSON.stringify(result.matchedKeywords),
    );
    updated++;
  }

  const after = getCategoryCounts(listingId);
  console.log(`\n=== Reclassify '${slug}' (${listingId}) ===`);
  console.log(`threads total:    ${threads.length}`);
  console.log(`re-classified:    ${updated}`);
  console.log(`manual (skipped): ${skippedManual}`);
  console.log('\nbefore:', before);
  console.log('after: ', after);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
