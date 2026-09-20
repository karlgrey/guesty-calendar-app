// src/repositories/draft-repository.ts
import { getDatabase } from '../db/index.js';
import type { MessageDraft, NewDraft } from '../types/messages.js';
import type { AutoSendDecision, AutoSendMode } from '../services/auto-send/types.js';

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

// Signatur erweitert: dritter Parameter (Default 'micha') — bestehende Aufrufer bleiben gültig.
export function markDraftSent(id: string, externalMessageId: string | null, sentBy: 'micha' | 'auto' = 'micha'): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'sent', external_message_id = ?, sent_at = datetime('now'), error = NULL, sent_by = ?
     WHERE id = ?`,
  ).run(externalMessageId, sentBy, id);
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

// --- Auto-Send-Gate (Migration 027) ---

export function setAutoDecision(id: string, d: AutoSendDecision, mode: AutoSendMode): void {
  getDatabase().prepare(
    `UPDATE message_drafts SET auto_decision = ?, auto_category = ?, auto_flags = ?, auto_reason = ?,
       auto_mode = ?, auto_judged_at = datetime('now') WHERE id = ?`,
  ).run(d.decision, d.category, JSON.stringify(d.flags), d.reason, mode, id);
}

export function setSentBodyChanged(id: string, changed: boolean): void {
  getDatabase().prepare(`UPDATE message_drafts SET sent_body_changed = ? WHERE id = ?`).run(changed ? 1 : 0, id);
}

/** Micha hat in diesem Thread schon eingegriffen (Spec 5.3 Thread-Ausschlüsse). */
export function threadHasHumanIntervention(threadId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT (
        EXISTS (SELECT 1 FROM message_drafts WHERE thread_id = @t AND status = 'discarded')
     OR EXISTS (SELECT 1 FROM draft_feedback WHERE thread_id = @t)
     OR EXISTS (SELECT 1 FROM message_threads WHERE id = @t AND manually_categorized = 1)
    ) AS hit`,
  ).get({ t: threadId }) as { hit: number };
  return row.hit === 1;
}

/**
 * Vorheriger Versand in diesem Thread ist fehlgeschlagen oder hängt fest (Final-Review F1):
 * ohne diesen Ausschluss erzeugt der nächste Loop-Lauf nach einem fehlgeschlagenen Auto-Send
 * einen neuen Entwurf, der das Gate erneut passieren und erneut senden könnte (Doppelversand-
 * Risiko, unbegrenzte Opus+Sende-Zyklen bei anhaltendem Fehler).
 */
export function threadHasFailedSend(threadId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT EXISTS (SELECT 1 FROM message_drafts WHERE thread_id = ? AND status IN ('error', 'sending')) AS hit`,
  ).get(threadId) as { hit: number };
  return row.hit === 1;
}

export function countAutoSentSince(sinceIso: string): number {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM message_drafts WHERE sent_by = 'auto' AND datetime(sent_at) >= datetime(?)`,
  ).get(sinceIso) as { n: number };
  return row.n;
}

export interface AwaitingDraftRow {
  id: string; thread_id: string; provider: string; status: string; created_at: string;
  reason: string; guest_name: string | null; listing_id: string; source: string;
  last_guest_message: string | null;
}

/**
 * Entwürfe, die auf Micha warten: Gate-Entscheidung 'wait' (noch pending), Send-Fehler,
 * oder hängende Sends (Final-Review F3, re-review-korrigiert) — zwei Zustände, die sonst
 * durchs Raster fallen: (a) auto_decision='auto'/auto_mode='live'/status='pending', aber
 * nie gesendet (Claim verloren / Prozess gestorben — blockiert neue Entwürfe im Thread und
 * wird nie gepusht), und (b) status='sending' nach einem Crash mitten im Versand (manuell
 * oder auto — deshalb kein auto_mode-Filter hier). 10-Minuten-Schwelle, damit ein Auto-Send,
 * der gerade erst geurteilt/geclaimt wurde, nicht fälschlich als hängend gilt.
 *
 * WICHTIG: der auto+pending-Fall gilt NUR für auto_mode='live' — im Schattenmodus ist
 * auto_decision='auto'/status='pending' der Normalzustand (nichts wird automatisch
 * gesendet, der Entwurf wartet bewusst auf Micha), Spec 4 verlangt „Push nur für
 * wait-Entscheidungen, auch im Schattenmodus". Ohne diesen Filter würde jeder gute
 * Schatten-Entwurf nach 10 Minuten fälschlich als „hängt" gepusht.
 */
export function getAwaitingDrafts(sinceIso: string, limit: number): AwaitingDraftRow[] {
  return getDatabase().prepare(
    `SELECT d.id, d.thread_id, d.provider, d.status, d.created_at,
       CASE
         WHEN d.status = 'error' THEN 'Auto-Send fehlgeschlagen: ' || COALESCE(d.error, '?')
         WHEN d.status = 'sending' THEN 'Versand hängt — bitte manuell prüfen'
         WHEN d.auto_decision = 'auto' AND d.auto_mode = 'live' AND d.status = 'pending' THEN 'Auto-Send hängt — bitte manuell prüfen'
         ELSE COALESCE(d.auto_reason, '')
       END AS reason,
       t.guest_name, t.listing_id, t.source,
       (SELECT m.body FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound'
          ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 1) AS last_guest_message
     FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE datetime(d.created_at) > datetime(?)
       AND (
         (d.auto_decision = 'wait' AND d.status = 'pending')
         OR d.status = 'error'
         OR (d.auto_decision = 'auto' AND d.auto_mode = 'live' AND d.status = 'pending' AND datetime(d.auto_judged_at) < datetime('now', '-10 minutes'))
         OR (d.status = 'sending' AND datetime(d.created_at) < datetime('now', '-10 minutes'))
       )
     ORDER BY d.created_at ASC LIMIT ?`,
  ).all(sinceIso, limit) as AwaitingDraftRow[];
}

export interface AutoSendStats {
  autoSent: number; waited: number; shadowWouldAuto: number;
  shadowUnchanged: number; shadowChanged: number; shadowDiscarded: number;
}
export function getAutoSendStats(sinceIso: string): AutoSendStats {
  return getDatabase().prepare(
    `SELECT
       SUM(sent_by = 'auto') AS autoSent,
       SUM(auto_decision = 'wait') AS waited,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow') AS shadowWouldAuto,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 0) AS shadowUnchanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 1) AS shadowChanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'discarded') AS shadowDiscarded
     FROM message_drafts WHERE datetime(created_at) >= datetime(?)`,
  ).get(sinceIso) as AutoSendStats;
}

export function listAutoDecisions(limit: number): Array<MessageDraft & { guest_name: string | null }> {
  return getDatabase().prepare(
    `SELECT d.*, t.guest_name FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE d.auto_decision IS NOT NULL ORDER BY d.created_at DESC LIMIT ?`,
  ).all(limit) as Array<MessageDraft & { guest_name: string | null }>;
}

/** Zuletzt gesendeter Draft eines Threads — für das grüne Auto-Send-Badge, wenn es gerade keinen aktiven (pending) Draft gibt. */
export function getLastSentDraftByThread(threadId: string): MessageDraft | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'sent'
              ORDER BY sent_at DESC LIMIT 1`)
    .get(threadId) as MessageDraft | undefined;
  return row ?? null;
}
