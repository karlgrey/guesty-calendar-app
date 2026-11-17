// src/services/inquiry-task-closer.ts
//
// #1210 (Entscheidung Micha 17.11.2026): Ein Inquiry-Task (Buchungsanfrage-Task #697, Art
// 'inquiry') schließt sich selbst, sobald die Antwort an den Gast gesendet ist — Versand über
// die App (Entwurf oder frei geschrieben) ODER direkt in Airbnb (Sync sieht die Host-Nachricht
// nach dem System-Post). Request-to-Book bleibt unberührt (Micha entscheidet in Airbnb).
//
// Regeln: idempotent (inquiry_task_closures, Migration 042), ein schon von Hand geschlossener
// oder verworfener Task (Done/Dropped) wird nicht angefasst, Tasks von vor der Migration
// ('legacy') auch nicht. Wirft NIE — SmartTasks-Fehler werden geloggt; vorübergehende Fehler
// geben den Claim frei (nächster Sync versucht erneut), dauerhafte 4xx werden als 'skipped'
// verbucht, damit nicht jeder Sync denselben Fehler wiederholt.
import { getSmartTasksClient, type SmartTasksClient } from './smarttasks-client.js';
import {
  findAnsweredInquiryTasks, claimInquiryTaskClosure, finishInquiryTaskClosure,
  releaseInquiryTaskClosure, releaseStaleInquiryTaskClaims, type AnsweredInquiryTask,
} from '../repositories/inquiry-task-closure-repository.js';
import { formatBerlinDateTime } from './auto-send/berlin-day.js';
import { ExternalApiError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const CLOSED_STATUSES = new Set(['Done', 'Dropped']);

export interface InquiryTaskCloserDeps {
  getClient: () => Pick<SmartTasksClient, 'getTask' | 'updateTaskStatus' | 'addComment'>;
  findAnswered: (threadId?: string) => AnsweredInquiryTask[];
  claim: (t: AnsweredInquiryTask) => boolean;
  finish: typeof finishInquiryTaskClosure;
  release: (taskId: number) => void;
  releaseStale: () => number;
}

const realDeps: InquiryTaskCloserDeps = {
  getClient: () => getSmartTasksClient(),
  findAnswered: findAnsweredInquiryTasks,
  claim: claimInquiryTaskClosure,
  finish: finishInquiryTaskClosure,
  release: releaseInquiryTaskClosure,
  releaseStale: releaseStaleInquiryTaskClaims,
};

export function buildClosureComment(answeredAt: string): string {
  return `Antwort gesendet ${formatBerlinDateTime(answeredAt)}, Task automatisch geschlossen`;
}

/** Dauerhafter Fehler (Task weg, keine Rechte, ungültig) — erneuter Versuch hilft nicht. */
function isPermanent(err: unknown): boolean {
  return err instanceof ExternalApiError && err.statusCode >= 400 && err.statusCode < 500
    && err.statusCode !== 408 && err.statusCode !== 429;
}

export interface CloseResult { closed: number; skipped: number; failed: number }

/**
 * Schließt alle beantworteten, noch nicht verbuchten Inquiry-Tasks (optional nur eines Threads).
 * Wirft nie.
 */
export async function closeAnsweredInquiryTasks(
  opts: { threadId?: string } = {},
  deps: InquiryTaskCloserDeps = realDeps,
): Promise<CloseResult> {
  const res: CloseResult = { closed: 0, skipped: 0, failed: 0 };
  let candidates: AnsweredInquiryTask[];
  try {
    deps.releaseStale();
    candidates = deps.findAnswered(opts.threadId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'inquiry-task-closer: Kandidaten-Abfrage fehlgeschlagen');
    return res;
  }
  for (const t of candidates) {
    if (!deps.claim(t)) continue; // anderer Lauf ist schon dran bzw. fertig
    try {
      const client = deps.getClient();
      const task = await client.getTask(t.taskId);
      if (CLOSED_STATUSES.has(task.status)) {
        deps.finish(t.taskId, 'skipped', `schon ${task.status}`);
        res.skipped++;
        continue;
      }
      await client.updateTaskStatus(t.taskId, 'Done');
      deps.finish(t.taskId, 'closed', null);
      res.closed++;
      try {
        await client.addComment(t.taskId, buildClosureComment(t.answeredAt));
      } catch (err) {
        // Task ist zu — Kommentar wird bewusst nicht wiederholt (sonst Doppelkommentar-Risiko).
        deps.finish(t.taskId, 'closed', 'Kommentar fehlgeschlagen');
        logger.warn({ taskId: t.taskId, err: err instanceof Error ? err.message : String(err) }, 'inquiry-task-closer: Task geschlossen, Kommentar fehlgeschlagen');
      }
      logger.info({ taskId: t.taskId, threadId: t.threadId, answeredAt: t.answeredAt }, 'inquiry-task-closer: Inquiry-Task nach gesendeter Antwort geschlossen');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        deps.finish(t.taskId, 'skipped', `Fehler: ${msg}`.slice(0, 500));
        res.skipped++;
      } else {
        deps.release(t.taskId);
        res.failed++;
      }
      logger.warn({ taskId: t.taskId, threadId: t.threadId, err: msg, permanent: isPermanent(err) }, 'inquiry-task-closer: Schließen fehlgeschlagen');
    }
  }
  return res;
}
