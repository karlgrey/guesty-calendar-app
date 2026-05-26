/**
 * LLM-classify a property's message threads.
 *
 * Iterates every auto-classified thread of the given property (manually_categorized = 0)
 * and runs the classifier on it. CONFIRMED threads are handled deterministically by
 * classifyThread itself (no API call). The Anthropic API is hit for the rest.
 *
 * Manual overrides are preserved by an extra guard in updateThreadClassification.
 *
 * Usage:
 *   npx tsx src/scripts/classify-threads.ts <slug>
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

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: classify-threads.ts <slug>');
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
  // fetch all threads — no pagination needed for a one-shot CLI
  const threads = getThreadsByListing(listingId, { limit: 100000 });

  console.log(`Classifying ${threads.length} thread(s) for '${slug}'...`);

  let updated = 0;
  let skippedManual = 0;
  let failed = 0;
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    if (thread.manually_categorized === 1) {
      skippedManual++;
      continue;
    }
    const messages = getMessagesByThread(thread.id).map((m) => ({
      direction: m.direction,
      body: m.body ?? '',
    }));
    try {
      const result = await classifyThread({
        reservationStatus: thread.reservation_status,
        channel: thread.channel,
        messages,
      });
      updateThreadClassification(
        thread.id,
        result.category,
        result.confidence,
        result.reasoning,
      );
      updated++;
    } catch (err) {
      failed++;
      console.error(
        `  ✗ thread ${thread.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  ... ${i + 1}/${threads.length} processed (${updated} ok, ${failed} fail, ${skippedManual} manual)`);
    }
  }

  const after = getCategoryCounts(listingId);
  console.log(`\n=== Classify '${slug}' (${listingId}) ===`);
  console.log(`threads total:    ${threads.length}`);
  console.log(`re-classified:    ${updated}`);
  console.log(`manual (skipped): ${skippedManual}`);
  console.log(`failed:           ${failed}`);
  console.log('\nbefore:', before);
  console.log('after: ', after);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
