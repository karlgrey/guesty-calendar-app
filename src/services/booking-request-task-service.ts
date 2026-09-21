// src/services/booking-request-task-service.ts
//
// #697 (Bauauftrag Standup 21.09.2026, Fall Anika Farmhouse): legt EINEN SmartTasks-Task für
// JEDE erkannte Airbnb-Buchungsanfrage an — unconditional, unabhängig davon, ob die (reine
// Rückfrage-)Antwort automatisch versendet wird oder auf 'wait' steht (anders als die
// Zusagen-Task-Fastlane #696, die nur bei einem sonst-automatischen Entwurf greift). Die
// Annahme/Ablehnung der Buchung entscheidet Micha ausschließlich in Airbnb, NACH der
// Gast-Antwort auf die Rückfrage — der Task trägt die Airbnb-24h-Frist.
//
// Idempotent pro Thread + Id des auslösenden Guesty-System-Posts (siehe booking-request.ts):
// nutzt bewusst dieselben Spalten wie der Zusagen-Task (#696, Migration 029) —
// smarttasks_task_guest_message_id trägt hier die System-Post-Id statt einer Gastnachrichten-Id
// (gleiche Semantik: "Id der Nachricht, die diesen Task ausgelöst hat"). Ausfall der
// SmartTasks-API wird abgefangen (nie werfen) — der Aufrufer (runner.ts/policy.ts) wertet das
// als wait, sendet aber trotzdem NIE automatisch ohne Task.
import { getSmartTasksClient } from './smarttasks-client.js';
import { findExistingSmartTasksTaskId, setSmartTasksTask } from '../repositories/draft-repository.js';
import { berlinCalendarDay, formatBerlinDeadline, nextBerlinBusinessDay } from './auto-send/berlin-day.js';
import { MICHA_SMARTTASKS_USER_ID } from './promise-task-service.js';
import { config } from '../config/index.js';
import type { PropertyConfig } from '../config/properties.js';
import type { AutoSendMode } from './auto-send/types.js';
import type { BookingRequestKind } from './booking-request.js';
import logger from '../utils/logger.js';

export interface BookingRequestTaskInput {
  draftId: string;
  threadId: string;
  /** Id des auslösenden Guesty-System-Posts (messages.id) — Idempotenz-Schlüssel. */
  systemMessageId: string;
  requestKind: BookingRequestKind;
  /** ISO-8601 UTC — Airbnb-24h-Antwortfrist (System-Post-Zeitpunkt + 24h). */
  platformDeadlineAt: string;
  guestName: string | null;
  guestMessage: string;
  draftBody: string;
  /** Strukturierter Zeitraum/Personen aus booking-context.ts (resolveBookingPeriod) — null,
   *  wenn nicht auflösbar (dann lässt der Titel das Feld weg, siehe buildBookingTaskTitle). */
  periodLabel: string | null;
  guestsCount: number | null;
  property: PropertyConfig;
  mode: AutoSendMode;
}

export interface BookingRequestTaskResult {
  created: boolean;
  taskNumber: number | null;
  reused: boolean;
}

const REQUEST_KIND_LABEL: Record<BookingRequestKind, string> = {
  inquiry: 'Inquiry',
  request_to_book: 'Request-to-Book',
};

function firstNameOf(guestName: string | null): string {
  const trimmed = (guestName ?? '').trim();
  return trimmed ? trimmed.split(/\s+/)[0] : 'Gast';
}

function adminUrl(threadId: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/admin/messages/${encodeURIComponent(threadId)}`;
}

/** Titel: "Airbnb-Anfrage <Vorname>: <Objekt-Code> <Zeitraum>, <Personen> P." — Zeitraum/
 *  Personen fehlen im Titel, wenn nicht auflösbar (Spec Punkt 6, "sonst weglassen"). */
export function buildBookingTaskTitle(
  i: Pick<BookingRequestTaskInput, 'guestName' | 'property' | 'periodLabel' | 'guestsCount'>,
): string {
  const code = i.property.shortCode ?? i.property.slug;
  const parts = [code];
  if (i.periodLabel) parts.push(i.periodLabel);
  let detail = parts.join(' ');
  if (i.guestsCount != null) detail += `, ${i.guestsCount} P.`;
  return `Airbnb-Anfrage ${firstNameOf(i.guestName)}: ${detail}`;
}

/** Beschreibung: Art der Anfrage, Thread-Link, Zitat der Gastnachricht, Zitat des Entwurfs,
 *  Airbnb-24h-Frist (Berlin-Zeit) inkl. Hinweis auf die bewusste Wochenend-Ausnahme, Datum;
 *  im Schattenmodus zusätzlich markiert (Spec Punkt 5/6). */
export function buildBookingTaskDescription(i: BookingRequestTaskInput): string {
  const quote = (s: string) => `> ${s.replace(/\r?\n/g, '\n> ')}`;
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `Airbnb-Buchungsanfrage (${REQUEST_KIND_LABEL[i.requestKind]}, ${i.property.name}) — ` +
      'die Annahme/Ablehnung entscheidest DU in Airbnb, nach der Gast-Antwort auf die automatische Rückfrage.',
  ];
  if (i.mode === 'shadow') {
    lines.push('**Schattenmodus** — die Rückfrage wird (noch) nicht automatisch gesendet, nur beobachtet.');
  }
  lines.push(
    '',
    `**Airbnb-Frist (24h):** ${formatBerlinDeadline(i.platformDeadlineAt)} Berlin — ` +
      'Due-Date ist bewusst der reale Kalendertag der Frist, auch am Wochenende (Ausnahme von der sonstigen Werktags-Regel).',
    '',
    '**Gastnachricht:**',
    quote(i.guestMessage),
    '',
    '**Automatische Rückfrage:**',
    quote(i.draftBody),
    '',
    `**Thread:** ${adminUrl(i.threadId)}`,
    '',
    `Datum: ${date}`,
  );
  return lines.join('\n');
}

/**
 * Legt den Buchungsanfrage-Task an — oder findet ihn wieder, wenn schon einer für denselben
 * System-Post existiert (Re-Sync/Re-Gate desselben Threads). Wirft NIE: ein API-Ausfall liefert
 * `{ created: false, taskNumber: null, reused: false }`, geloggt als warn.
 */
export async function resolveBookingRequestTask(i: BookingRequestTaskInput): Promise<BookingRequestTaskResult> {
  const existing = findExistingSmartTasksTaskId(i.threadId, i.systemMessageId);
  if (existing) {
    setSmartTasksTask(i.draftId, existing, i.systemMessageId);
    return { created: true, taskNumber: existing, reused: true };
  }
  try {
    const client = getSmartTasksClient();
    const task = await client.createTask({
      title: buildBookingTaskTitle(i),
      description: buildBookingTaskDescription(i),
      status: 'To Do',
      assigneeId: MICHA_SMARTTASKS_USER_ID,
      projectId: i.property.smartTasksAirbnbProjectId,
      // Bewusst KEINE Werktags-Verschiebung — die Airbnb-24h-Frist gilt real auch am Wochenende
      // (anders als die Zusagen-Task-Fälligkeit #696). platformDeadlineAt sollte durch
      // booking-request.ts immer gesetzt sein; nextBerlinBusinessDay ist nur ein defensiver
      // Fallback für den theoretischen Fall eines fehlenden Zeitpunkts.
      dueDate: i.platformDeadlineAt ? berlinCalendarDay(i.platformDeadlineAt) : nextBerlinBusinessDay(),
    });
    setSmartTasksTask(i.draftId, task.id, i.systemMessageId);
    return { created: true, taskNumber: task.id, reused: false };
  } catch (err) {
    logger.warn(
      { draftId: i.draftId, threadId: i.threadId, err: err instanceof Error ? err.message : String(err) },
      'booking-request-task: SmartTasks-Anlage fehlgeschlagen — Entwurf bleibt wait',
    );
    return { created: false, taskNumber: null, reused: false };
  }
}
