// src/repositories/inquiry-task-closure-repository.ts
//
// #1210: Selbstschluss beantworteter Inquiry-Tasks — DB-Teil (Migration 042). Ein Inquiry-Task
// (Buchungsanfrage-Task #697 mit request_kind 'inquiry') gilt als beantwortet, sobald im Thread
// eine outbound-Nachricht ZEITLICH NACH dem auslösenden Guesty-System-Post steht — egal ob über
// die App gesendet (draft-send-service.ts legt die outbound-Zeile sofort an) oder direkt in
// Airbnb (der Sync bringt die Host-Nachricht). inquiry_task_closures ist der Idempotenz-Anker.
//
// Zusätzlich muss die Host-Nachricht NACH dem Entwurf liegen, an dem der Task hängt (frühester
// Draft je Task = Zeitpunkt der Task-Anlage). Sonst schlösse sich ein Task der Folgerunde sofort
// wieder: Runde 1 automatisch beantwortet (kein Task), Gast schreibt erneut, Entwurf wartet →
// Task entsteht am SELBEN System-Post, die alte Auto-Antwort läge schon „nach dem System-Post".
import { getDatabase } from '../db/index.js';

export interface AnsweredInquiryTask {
  taskId: number;
  threadId: string;
  /** sent_at der ersten Host-Nachricht nach System-Post UND Task-Entwurf. */
  answeredAt: string;
}

export type InquiryTaskClosureOutcome = 'closed' | 'skipped';

/** Inquiry-Tasks mit gesendeter Antwort, für die noch kein Schließ-Versuch verbucht ist. */
export function findAnsweredInquiryTasks(threadId?: string): AnsweredInquiryTask[] {
  const rows = getDatabase().prepare(
    `SELECT d.smarttasks_task_id AS taskId, d.thread_id AS threadId,
       MIN((SELECT o.sent_at FROM messages o
            WHERE o.thread_id = d.thread_id AND o.direction = 'outbound'
              AND julianday(o.sent_at) > julianday(sys.sent_at)
              AND julianday(o.sent_at) > julianday(d.created_at)
            ORDER BY julianday(o.sent_at) ASC LIMIT 1)) AS answeredAt
     FROM message_drafts d
     JOIN messages sys ON sys.id = d.smarttasks_task_guest_message_id AND sys.direction = 'system'
     WHERE d.request_kind = 'inquiry' AND d.smarttasks_task_id IS NOT NULL
       AND (? IS NULL OR d.thread_id = ?)
       AND NOT EXISTS (SELECT 1 FROM inquiry_task_closures c WHERE c.task_id = d.smarttasks_task_id)
     GROUP BY d.smarttasks_task_id
     HAVING answeredAt IS NOT NULL
     ORDER BY d.smarttasks_task_id`,
  ).all(threadId ?? null, threadId ?? null) as AnsweredInquiryTask[];
  return rows;
}

/** Atomarer Claim (better-sqlite3 ist synchron): true nur für den ersten Aufrufer je Task. */
export function claimInquiryTaskClosure(t: AnsweredInquiryTask): boolean {
  const r = getDatabase().prepare(
    `INSERT OR IGNORE INTO inquiry_task_closures (task_id, thread_id, outcome, answered_at)
     VALUES (?, ?, 'pending', ?)`,
  ).run(t.taskId, t.threadId, t.answeredAt);
  return r.changes === 1;
}

export function finishInquiryTaskClosure(taskId: number, outcome: InquiryTaskClosureOutcome, detail: string | null = null): void {
  getDatabase().prepare(
    `UPDATE inquiry_task_closures SET outcome = ?, detail = ?, updated_at = datetime('now') WHERE task_id = ?`,
  ).run(outcome, detail, taskId);
}

/** Vorübergehender Fehler (Netz/5xx/kein Key): Claim zurückgeben, nächster Sync versucht erneut. */
export function releaseInquiryTaskClosure(taskId: number): void {
  getDatabase().prepare(`DELETE FROM inquiry_task_closures WHERE task_id = ? AND outcome = 'pending'`).run(taskId);
}

/** Hängende Claims (Prozess mitten im Versuch gestorben) nach einer Stunde wieder freigeben. */
export function releaseStaleInquiryTaskClaims(): number {
  return getDatabase().prepare(
    `DELETE FROM inquiry_task_closures WHERE outcome = 'pending' AND updated_at < datetime('now', '-1 hour')`,
  ).run().changes;
}
