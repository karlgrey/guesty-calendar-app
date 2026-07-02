// src/repositories/feedback-repository.ts
import { getDatabase } from '../db/index.js';
import type { NewFeedback, VaultSuggestion, NewSuggestion } from '../types/feedback.js';

export function createFeedback(f: NewFeedback): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO draft_feedback (id, thread_id, draft_id, category, note)
     VALUES (@id, @thread_id, @draft_id, @category, @note)`,
  ).run({ ...f, draft_id: f.draft_id ?? null });
}

export function createSuggestion(s: NewSuggestion): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO vault_suggestions (id, feedback_id, target_file, target_heading, addition_text, rationale)
     VALUES (@id, @feedback_id, @target_file, @target_heading, @addition_text, @rationale)`,
  ).run(s);
}

export function getSuggestionById(id: string): VaultSuggestion | null {
  const db = getDatabase();
  return (db.prepare(`SELECT * FROM vault_suggestions WHERE id = ?`).get(id) as VaultSuggestion | undefined) ?? null;
}

export function getPendingSuggestions(): VaultSuggestion[] {
  const db = getDatabase();
  return db.prepare(`SELECT * FROM vault_suggestions WHERE status = 'pending' ORDER BY created_at ASC`).all() as VaultSuggestion[];
}

export function countPendingSuggestions(): number {
  const db = getDatabase();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM vault_suggestions WHERE status = 'pending'`).get() as { n: number };
  return row.n;
}

export function markSuggestionApplied(id: string, commit: string | null): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE vault_suggestions SET status = 'approved', applied_commit = ?, applied_at = datetime('now') WHERE id = ?`,
  ).run(commit, id);
}

export function discardSuggestion(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE vault_suggestions SET status = 'discarded' WHERE id = ?`).run(id);
}
