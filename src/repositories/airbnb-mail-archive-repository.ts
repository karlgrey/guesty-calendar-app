/**
 * Airbnb Mail Archive Repository
 *
 * Stores raw mail bodies for audit + replay. Tracks per-property IMAP UID
 * state for incremental polling. See migration 013.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface NewMailRow {
  property_slug: string;
  message_id: string;
  imap_uid: number;
  subject: string | null;
  from_address: string | null;
  received_at: string;
  raw_body: string;
  detected_type: string | null;
  reservation_code: string | null;
  parse_status: 'pending' | 'ok' | 'error';
  parse_error: string | null;
}

export interface MailRow extends NewMailRow {
  id: number;
  created_at: string;
}

export function insertMail(row: NewMailRow): void {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO airbnb_mail_archive (
        property_slug, message_id, imap_uid, subject, from_address,
        received_at, raw_body, detected_type, reservation_code,
        parse_status, parse_error
      ) VALUES (
        @property_slug, @message_id, @imap_uid, @subject, @from_address,
        @received_at, @raw_body, @detected_type, @reservation_code,
        @parse_status, @parse_error
      )
      ON CONFLICT(message_id) DO NOTHING
    `).run(row);
  } catch (error) {
    logger.error({ error, message_id: row.message_id }, 'Failed to insert airbnb mail');
    throw new DatabaseError(`Failed to insert airbnb mail: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function updateParseStatus(
  messageId: string,
  status: 'ok' | 'error',
  parseError: string | null = null,
  reservationCode: string | null = null,
  detectedType: string | null = null
): void {
  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE airbnb_mail_archive
      SET parse_status = ?, parse_error = ?, reservation_code = ?, detected_type = COALESCE(?, detected_type)
      WHERE message_id = ?
    `).run(status, parseError, reservationCode, detectedType, messageId);
  } catch (error) {
    logger.error({ error, messageId }, 'Failed to update parse status');
    throw new DatabaseError(`Failed to update parse status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getMail(messageId: string): MailRow | null {
  const db = getDatabase();
  try {
    const row = db.prepare(`SELECT * FROM airbnb_mail_archive WHERE message_id = ?`).get(messageId);
    return (row as MailRow) ?? null;
  } catch (error) {
    logger.error({ error, messageId }, 'Failed to get mail');
    throw new DatabaseError(`Failed to get mail: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function pruneOldMails(olderThanDays: number): number {
  const db = getDatabase();
  try {
    const result = db.prepare(
      `DELETE FROM airbnb_mail_archive WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
    return result.changes;
  } catch (error) {
    logger.error({ error, olderThanDays }, 'Failed to prune old mails');
    throw new DatabaseError(`Failed to prune old mails: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getLastUid(propertySlug: string): number {
  const db = getDatabase();
  try {
    const row = db.prepare(`SELECT last_imap_uid FROM airbnb_mail_state WHERE property_slug = ?`).get(propertySlug) as { last_imap_uid: number } | undefined;
    return row?.last_imap_uid ?? 0;
  } catch (error) {
    logger.error({ error, propertySlug }, 'Failed to get last UID');
    throw new DatabaseError(`Failed to get last UID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function setLastUid(propertySlug: string, uid: number): void {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO airbnb_mail_state (property_slug, last_imap_uid, last_sync_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(property_slug) DO UPDATE SET
        last_imap_uid = excluded.last_imap_uid,
        last_sync_at = excluded.last_sync_at
    `).run(propertySlug, uid);
  } catch (error) {
    logger.error({ error, propertySlug, uid }, 'Failed to set last UID');
    throw new DatabaseError(`Failed to set last UID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getErrorMails(propertySlug?: string): MailRow[] {
  const db = getDatabase();
  try {
    if (propertySlug) {
      return db.prepare(
        `SELECT * FROM airbnb_mail_archive WHERE parse_status = 'error' AND property_slug = ? ORDER BY received_at DESC`
      ).all(propertySlug) as MailRow[];
    }
    return db.prepare(
      `SELECT * FROM airbnb_mail_archive WHERE parse_status = 'error' ORDER BY received_at DESC`
    ).all() as MailRow[];
  } catch (error) {
    logger.error({ error, propertySlug }, 'Failed to get error mails');
    throw new DatabaseError(`Failed to get error mails: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
