// src/repositories/draft-repository.ts
import { getDatabase } from '../db/index.js';
import type { MessageDraft, NewDraft } from '../types/messages.js';

export function createDraft(d: NewDraft): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO message_drafts (id, thread_id, provider, body, generated_by, model)
     VALUES (@id, @thread_id, @provider, @body, @generated_by, @model)`,
  ).run({ ...d, model: d.model ?? null });
}

export function getDraftById(id: string): MessageDraft | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM message_drafts WHERE id = ?`).get(id) as MessageDraft | undefined;
  return row ?? null;
}

export function getActiveDraftByThread(threadId: string): MessageDraft | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'pending'
              ORDER BY created_at DESC LIMIT 1`)
    .get(threadId) as MessageDraft | undefined;
  return row ?? null;
}

/**
 * Atomically transition a draft from 'pending' → 'sending'.
 * Returns true if the claim succeeded (exactly one row updated), false otherwise.
 * Two concurrent callers: the first wins, the second gets false (TOCTOU guard).
 */
export function claimDraftForSending(id: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`UPDATE message_drafts SET status = 'sending' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return result.changes === 1;
}

export function markDraftSent(id: string, externalMessageId: string | null): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'sent', external_message_id = ?, sent_at = datetime('now'), error = NULL
     WHERE id = ?`,
  ).run(externalMessageId, id);
}

export function markDraftError(id: string, error: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'error', error = ?, send_attempts = send_attempts + 1
     WHERE id = ?`,
  ).run(error, id);
}

export function discardDraft(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET status = 'discarded' WHERE id = ?`).run(id);
}

export function updateDraftBody(id: string, body: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET body = ? WHERE id = ?`).run(body, id);
}
