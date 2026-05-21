/**
 * Backfill: link Gmail message_threads to manual Guesty reservations.
 *
 * Reads all gmail threads + manual reservations for a property, runs the
 * matcher, persists thread.reservation_id when a confident match is found.
 *
 * Usage:
 *   npx tsx src/scripts/link-threads-to-reservations.ts <slug>
 */

import { initDatabase, getDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import {
  matchThreadToReservation,
  type ReservationMatcherCandidate,
} from '../utils/thread-reservation-matcher.js';
import { classifyThread } from '../utils/message-classifier.js';

interface ThreadRow {
  id: string;
  guest_name: string | null;
  guest_email: string | null;
  last_message_at: string;
  reservation_id: string | null;
  channel: string;
  reservation_status: string | null;
}

interface ReservationRow {
  reservation_id: string;
  guest_name: string | null;
  check_in: string;
  status: string;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: link-threads-to-reservations.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }
  const listingId =
    property.guestyPropertyId ?? property.hostexPropertyId ?? property.airbnbListingId;
  if (!listingId) {
    console.error(`Property '${slug}' has no listing id`);
    process.exit(1);
  }

  initDatabase();
  const db = getDatabase();

  const threads = db
    .prepare(
      `SELECT id, guest_name, guest_email, last_message_at, reservation_id, channel, reservation_status
       FROM message_threads
       WHERE listing_id = ? AND source = 'gmail'`,
    )
    .all(listingId) as ThreadRow[];

  const reservations = db
    .prepare(
      `SELECT reservation_id, guest_name, check_in, status
       FROM reservations
       WHERE listing_id = ? AND source IN ('manual', 'meetreet')
         AND status IN ('confirmed', 'reserved', 'active')`,
    )
    .all(listingId) as ReservationRow[];

  const candidates: ReservationMatcherCandidate[] = reservations.map((r) => ({
    reservationId: r.reservation_id,
    guestName: r.guest_name,
    checkIn: r.check_in,
  }));

  console.log(`Threads (gmail): ${threads.length}, Reservation candidates: ${candidates.length}`);

  // Preserve manual category overrides — only re-classify auto-categorized threads.
  const updateStmt = db.prepare(
    `UPDATE message_threads
     SET reservation_id = ?,
         reservation_status = ?,
         conversion_category = CASE WHEN manually_categorized = 1 THEN conversion_category ELSE ? END,
         classification_confidence = CASE WHEN manually_categorized = 1 THEN classification_confidence ELSE ? END
     WHERE id = ?`,
  );

  const getMessagesStmt = db.prepare(
    `SELECT direction, body FROM messages WHERE thread_id = ? ORDER BY sent_at`,
  );

  let matched = 0;
  let alreadyLinked = 0;
  for (const t of threads) {
    if (t.reservation_id) {
      alreadyLinked++;
      continue;
    }
    const match = matchThreadToReservation(
      {
        guestName: t.guest_name,
        guestEmail: t.guest_email,
        lastMessageAt: t.last_message_at,
      },
      candidates,
    );
    if (!match) continue;

    // Re-classify with the new reservation_status so CONFIRMED is detected.
    const linkedRes = reservations.find((r) => r.reservation_id === match.reservationId);
    const newStatus = linkedRes?.status ?? null;

    const msgs = getMessagesStmt.all(t.id) as Array<{ direction: string; body: string }>;
    const classification = classifyThread({
      reservationStatus: newStatus,
      channel: t.channel,
      messages: msgs.map((m) => ({
        direction: m.direction as 'inbound' | 'outbound' | 'system',
        body: m.body,
      })),
    });

    updateStmt.run(
      match.reservationId,
      newStatus,
      classification.category,
      classification.confidence,
      t.id,
    );
    matched++;
    console.log(
      `  → ${t.guest_name || t.guest_email} → ${match.reservationId}` +
        ` (score ${match.score.toFixed(1)}, cat ${classification.category})`,
    );
  }

  console.log(`\nDone. matched=${matched}, alreadyLinked=${alreadyLinked}, unmatched=${threads.length - matched - alreadyLinked}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
