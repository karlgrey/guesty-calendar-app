// src/repositories/review-draft-repository.ts
import { getDatabase } from '../db/index.js';
import type { NewReviewDraft, ReviewDraft } from '../types/reviews.js';

export function createReviewDraft(d: NewReviewDraft): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO review_drafts (id, reservation_id, listing_id, provider, guest_name, check_out, status, body, flag_reason, generated_by, model)
     VALUES (@id, @reservation_id, @listing_id, @provider, @guest_name, @check_out, @status, @body, @flag_reason, @generated_by, @model)`,
  ).run({
    ...d,
    body: d.body ?? null,
    flag_reason: d.flag_reason ?? null,
    model: d.model ?? null,
  });
}

export function getReviewDraftById(id: string): ReviewDraft | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM review_drafts WHERE id = ?`).get(id) as ReviewDraft | undefined;
  return row ?? null;
}

/** Whether a review draft already exists for this reservation (any status) — the one-per-stay invariant. */
export function hasReviewDraftForReservation(reservationId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(`SELECT 1 FROM review_drafts WHERE reservation_id = ?`).get(reservationId);
  return !!row;
}

/**
 * Open review drafts (pending + needs_review) across all properties, newest
 * checkout first — feeds the admin list (`/admin/reviews`).
 */
export function getOpenReviewDrafts(limit = 200): ReviewDraft[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM review_drafts WHERE status IN ('pending','needs_review')
       ORDER BY check_out DESC LIMIT ?`,
    )
    .all(limit) as ReviewDraft[];
}

export function markReviewDraftDone(id: string, body: string | null): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE review_drafts SET status = 'done', done_at = datetime('now'), body = COALESCE(?, body) WHERE id = ?`,
  ).run(body, id);
}

export function discardReviewDraft(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE review_drafts SET status = 'discarded' WHERE id = ?`).run(id);
}

export function updateReviewDraftBody(id: string, body: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE review_drafts SET body = ? WHERE id = ?`).run(body, id);
}

/**
 * Replace a 'needs_review'/'pending' draft's content after a manual regenerate —
 * used the same way regenerate works for message drafts (discard + recreate would
 * also work, but an in-place update keeps the row/id and its created_at history).
 */
export function setReviewDraftContent(
  id: string,
  fields: { status: 'pending' | 'needs_review'; body: string | null; flag_reason: string | null; model: string | null },
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE review_drafts SET status = ?, body = ?, flag_reason = ?, model = ? WHERE id = ?`,
  ).run(fields.status, fields.body, fields.flag_reason, fields.model, id);
}
