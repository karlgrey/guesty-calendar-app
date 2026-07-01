/**
 * Message + Thread Repository
 *
 * Stores unified conversation history from Guesty + direct-email sources.
 * Threads are upserted idempotently — re-syncing the same conversation is a
 * no-op for unchanged messages.
 *
 * See migration 014_add_messages_threads.sql.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type {
  Message,
  MessageThread,
  NewMessage,
  NewMessageThread,
} from '../types/messages.js';

export function upsertThread(thread: NewMessageThread): void {
  const db = getDatabase();
  try {
    db.prepare(
      `INSERT INTO message_threads (
        id, listing_id, source, channel, guest_name, guest_email,
        first_message_at, last_message_at, message_count,
        reservation_id, inquiry_id, reservation_status,
        conversion_category, classification_confidence, classification_keywords,
        raw_meta, last_synced_at
      ) VALUES (
        @id, @listing_id, @source, @channel, @guest_name, @guest_email,
        @first_message_at, @last_message_at, @message_count,
        @reservation_id, @inquiry_id, @reservation_status,
        @conversion_category, @classification_confidence, @classification_keywords,
        @raw_meta, @last_synced_at
      )
      ON CONFLICT(id) DO UPDATE SET
        guest_name = excluded.guest_name,
        guest_email = excluded.guest_email,
        first_message_at = excluded.first_message_at,
        last_message_at = excluded.last_message_at,
        message_count = excluded.message_count,
        reservation_id = excluded.reservation_id,
        inquiry_id = excluded.inquiry_id,
        reservation_status = excluded.reservation_status,
        -- Manual override always wins. Otherwise: if sync provides a value, use
        -- it; if it passes NULL (the post-decoupling default), keep the existing
        -- classification so a re-sync doesn't erase what classify-threads.ts set.
        conversion_category = CASE WHEN manually_categorized = 1
                                   THEN conversion_category
                                   ELSE COALESCE(excluded.conversion_category, conversion_category) END,
        classification_confidence = CASE WHEN manually_categorized = 1
                                         THEN classification_confidence
                                         ELSE COALESCE(excluded.classification_confidence, classification_confidence) END,
        classification_keywords = CASE WHEN manually_categorized = 1
                                       THEN classification_keywords
                                       ELSE COALESCE(excluded.classification_keywords, classification_keywords) END,
        raw_meta = excluded.raw_meta,
        last_synced_at = excluded.last_synced_at`,
    ).run(thread);
  } catch (error) {
    logger.error({ error, threadId: thread.id }, 'Failed to upsert message thread');
    throw new DatabaseError(
      `Failed to upsert message thread: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function upsertMessage(msg: NewMessage): void {
  const db = getDatabase();
  try {
    db.prepare(
      `INSERT INTO messages (
        id, thread_id, direction, sent_at, from_name, from_address,
        to_address, subject, body, body_html, source, raw_meta
      ) VALUES (
        @id, @thread_id, @direction, @sent_at, @from_name, @from_address,
        @to_address, @subject, @body, @body_html, @source, @raw_meta
      )
      ON CONFLICT(id) DO UPDATE SET
        direction = excluded.direction,
        sent_at = excluded.sent_at,
        from_name = excluded.from_name,
        from_address = excluded.from_address,
        to_address = excluded.to_address,
        subject = excluded.subject,
        body = excluded.body,
        body_html = excluded.body_html,
        raw_meta = excluded.raw_meta`,
    ).run(msg);
  } catch (error) {
    logger.error({ error, messageId: msg.id }, 'Failed to upsert message');
    throw new DatabaseError(
      `Failed to upsert message: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function setLinkedThreadId(threadId: string, linkedId: string | null): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_threads SET linked_thread_id = ? WHERE id = ?`).run(linkedId, threadId);
}

export function setManualCategory(
  threadId: string,
  category: string | null,
  note: string | null,
): boolean {
  const db = getDatabase();
  // Setting category=null clears the override (back to auto-classify)
  const manual = category === null ? 0 : 1;
  const result = db
    .prepare(
      `UPDATE message_threads
       SET conversion_category = COALESCE(?, conversion_category),
           manually_categorized = ?,
           manual_note = ?
       WHERE id = ?`,
    )
    .run(category, manual, note, threadId);
  return result.changes > 0;
}

/**
 * Overwrite a thread's auto-classification with LLM output.
 * Guards on manually_categorized = 0 so manual overrides are never touched.
 */
export function updateThreadClassification(
  threadId: string,
  category: string,
  confidence: number,
  reasoning: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_threads
     SET conversion_category = ?,
         classification_confidence = ?,
         classification_reasoning = ?
     WHERE id = ? AND manually_categorized = 0`,
  ).run(category, confidence, reasoning, threadId);
}

export function getThreadById(id: string): MessageThread | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM message_threads WHERE id = ?`).get(id) as
    | MessageThread
    | undefined;
  return row ?? null;
}

export function getThreadsByListing(
  listingId: string,
  opts?: { limit?: number; category?: string | null },
): MessageThread[] {
  const db = getDatabase();
  if (opts?.category !== undefined) {
    return db
      .prepare(
        `SELECT * FROM message_threads
         WHERE listing_id = ? AND conversion_category IS ?
         ORDER BY last_message_at DESC
         LIMIT ?`,
      )
      .all(listingId, opts.category, opts.limit ?? 500) as MessageThread[];
  }
  return db
    .prepare(
      `SELECT * FROM message_threads
       WHERE listing_id = ?
       ORDER BY last_message_at DESC
       LIMIT ?`,
    )
    .all(listingId, opts?.limit ?? 500) as MessageThread[];
}

export function getMessagesByThread(threadId: string): Message[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC`)
    .all(threadId) as Message[];
}

export function getLastEmailUid(propertySlug: string): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT last_imap_uid FROM direct_email_state WHERE property_slug = ?`)
    .get(propertySlug) as { last_imap_uid: number } | undefined;
  return row?.last_imap_uid ?? 0;
}

export function setLastEmailUid(propertySlug: string, uid: number): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO direct_email_state (property_slug, last_imap_uid, last_sync_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(property_slug) DO UPDATE SET
       last_imap_uid = excluded.last_imap_uid,
       last_sync_at = excluded.last_sync_at`,
  ).run(propertySlug, uid);
}

export function countThreads(listingId: string): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM message_threads WHERE listing_id = ?`)
    .get(listingId) as { n: number };
  return row.n;
}

export function getCategoryCounts(
  listingId: string,
): Record<string, number> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT COALESCE(conversion_category, 'UNCATEGORIZED') AS category, COUNT(*) AS n
       FROM message_threads WHERE listing_id = ? GROUP BY category`,
    )
    .all(listingId) as Array<{ category: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

export function getThreadsNeedingReply(): MessageThread[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT t.* FROM message_threads t
       WHERE (
         SELECT m.direction FROM messages m
         WHERE m.thread_id = t.id
         ORDER BY m.sent_at DESC, m.created_at DESC
         LIMIT 1
       ) = 'inbound'
       ORDER BY t.last_message_at DESC`,
    )
    .all() as MessageThread[];
}
