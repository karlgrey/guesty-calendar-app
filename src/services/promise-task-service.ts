// src/services/promise-task-service.ts
//
// #696 (Standup 21.09.2026, Fall Lorenzo U19): legt einen SmartTasks-Task an, wenn ein
// Gäste-Entwurf eine Zusage enthält (Judge-Flag promises_action), statt den Versand zu
// blockieren — Kernidee: "Eine Zusage ist kein Grund zu warten, wenn sie nachweislich
// nachgehalten wird." Idempotent pro Thread+letzter-Gastnachricht (Spec Punkt 6): ein
// Re-Generate im selben Thread für dieselbe Gastnachricht (z. B. nach einer
// Sprach-Pin-Korrektur, #695) findet über draft-repository.ts den bestehenden Task
// wieder statt einen zweiten anzulegen. Ausfall der SmartTasks-API wird abgefangen
// (nie werfen) — der Aufrufer (runner.ts/policy.ts) wertet das als wait.
import { getSmartTasksClient } from './smarttasks-client.js';
import { findExistingSmartTasksTaskId, setSmartTasksTask } from '../repositories/draft-repository.js';
import { nextBerlinBusinessDay } from './auto-send/berlin-day.js';
import { config } from '../config/index.js';
import type { PropertyConfig } from '../config/properties.js';
import type { AutoSendMode } from './auto-send/types.js';
import logger from '../utils/logger.js';

/** SmartTasks-User-Id von Micha — fester Business-Fakt (kein Geheimnis), Assignee jedes
 *  Zusagen-Tasks. */
export const MICHA_SMARTTASKS_USER_ID = 1;

export interface PromiseTaskInput {
  draftId: string;
  threadId: string;
  /** Id der letzten Gastnachricht (messages.id) — Idempotenz-Schlüssel. null, wenn nicht
   *  auflösbar (dann wird ohne Wiederverwendungs-Check direkt angelegt). */
  guestMessageId: string | null;
  guestName: string | null;
  guestMessage: string;
  draftBody: string;
  promisedAction: string;
  property: PropertyConfig;
  mode: AutoSendMode;
}

export interface PromiseTaskResult {
  created: boolean;
  taskNumber: number | null;
  reused: boolean;
}

function firstNameOf(guestName: string | null): string {
  const trimmed = (guestName ?? '').trim();
  return trimmed ? trimmed.split(/\s+/)[0] : 'Gast';
}

function adminUrl(threadId: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/admin/messages/${encodeURIComponent(threadId)}`;
}

/** Titel: "Zusage an Gast <Vorname> (<Objekt-Code>): <promised_action>" (Spec Punkt 3). */
export function buildPromiseTaskTitle(i: Pick<PromiseTaskInput, 'guestName' | 'property' | 'promisedAction'>): string {
  const code = i.property.shortCode ?? i.property.slug;
  return `Zusage an Gast ${firstNameOf(i.guestName)} (${code}): ${i.promisedAction}`;
}

/** Beschreibung: Thread-Link, Zitat der Gastnachricht, Zitat des Entwurfs, Datum (Spec
 *  Punkt 3); im Schattenmodus zusätzlich markiert (Spec Punkt 5). */
export function buildPromiseTaskDescription(i: PromiseTaskInput): string {
  const quote = (s: string) => `> ${s.replace(/\r?\n/g, '\n> ')}`;
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `Zusage im Gäste-Entwurf (Auto-Send-Gate, ${i.property.name}).`,
  ];
  if (i.mode === 'shadow') {
    lines.push('**Schattenmodus** — dieser Entwurf wird (noch) nicht automatisch gesendet, nur beobachtet.');
  }
  lines.push(
    '',
    `**Zusage:** ${i.promisedAction}`,
    '',
    '**Gastnachricht:**',
    quote(i.guestMessage),
    '',
    '**Entwurf:**',
    quote(i.draftBody),
    '',
    `**Thread:** ${adminUrl(i.threadId)}`,
    '',
    `Datum: ${date}`,
  );
  return lines.join('\n');
}

/**
 * Legt den Zusagen-Task an — oder findet ihn wieder, wenn schon einer für dieselbe
 * Gastnachricht in diesem Thread existiert. Wirft NIE: ein API-Ausfall liefert
 * `{ created: false, taskNumber: null, reused: false }`, geloggt als warn (Spec Punkt 1,
 * "Ausfall der SmartTasks-API darf den Versand nie blockieren").
 */
export async function resolvePromiseTask(i: PromiseTaskInput): Promise<PromiseTaskResult> {
  if (i.guestMessageId) {
    const existing = findExistingSmartTasksTaskId(i.threadId, i.guestMessageId);
    if (existing) {
      setSmartTasksTask(i.draftId, existing, i.guestMessageId);
      return { created: true, taskNumber: existing, reused: true };
    }
  }
  try {
    const client = getSmartTasksClient();
    const task = await client.createTask({
      title: buildPromiseTaskTitle(i),
      description: buildPromiseTaskDescription(i),
      status: 'To Do',
      assigneeId: MICHA_SMARTTASKS_USER_ID,
      projectId: i.property.smartTasksProjectId,
      dueDate: nextBerlinBusinessDay(),
    });
    setSmartTasksTask(i.draftId, task.id, i.guestMessageId);
    return { created: true, taskNumber: task.id, reused: false };
  } catch (err) {
    logger.warn(
      { draftId: i.draftId, threadId: i.threadId, err: err instanceof Error ? err.message : String(err) },
      'promise-task: SmartTasks-Anlage fehlgeschlagen — Entwurf bleibt wait',
    );
    return { created: false, taskNumber: null, reused: false };
  }
}
