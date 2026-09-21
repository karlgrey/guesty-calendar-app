// Orchestrierung des Gates (Spec 4 + 5): Entwurf liegt bereits als pending in message_drafts.
import { config } from '../../config/index.js';
import type { Message, MessageThread } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';
import { judgeDraft, type JudgeInput } from './judge-service.js';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';
import { decide, wouldAutoWithPromiseTask, type PolicyInput } from './policy.js';
import { resolveAutoSendMode } from './mode.js';
import { startOfBerlinDayIso, formatBerlinDeadline } from './berlin-day.js';
import type { AutoSendDecision, AutoSendMode, JudgeResult } from './types.js';
import type { SupportedLanguage } from '../../utils/language-detect.js';
import { setAutoDecision, threadHasHumanIntervention, threadHasFailedSend, countAutoSentSince, claimDraftForSending, setBookingRequestContext } from '../../repositories/draft-repository.js';
import { getSchedulerState } from '../../repositories/scheduler-state-repository.js';
import { resolveOutboundModuleType } from '../guesty-channel.js';
import { sendClaimedDraft } from '../draft-send-service.js';
import { resolvePromiseTask, type PromiseTaskInput, type PromiseTaskResult } from '../promise-task-service.js';
import { findOpenBookingRequest } from '../booking-request.js';
import { resolveBookingRequestTask, type BookingRequestTaskInput, type BookingRequestTaskResult } from '../booking-request-task-service.js';
import { resolveBookingPeriod } from '../booking-context.js';
import logger from '../../utils/logger.js';

export const PAUSE_KEY = 'auto_send_paused';

export interface GateInput {
  draftId: string; body: string; thread: MessageThread; messages: Message[];
  voice: string; facts: string; bookingContext: string | null; property: PropertyConfig;
  // #695: deterministisch erkannte Sprache der letzten Gastnachricht — geht an Judge und
  // mechanische Prüfung weiter (Spec 1+2). Optional, damit bestehende Aufrufer/Tests ohne
  // dieses Feld weiterlaufen (dann läuft kein Sprach-Check).
  guestLanguage?: SupportedLanguage;
  // #695 Spec Punkt 3: 2 markiert den automatischen Neuversuch nach language_mismatch — die
  // persistierte Entscheidung bekommt dann den Präfix „Neuversuch: “ im Reason (auto_reason).
  attempt?: 1 | 2;
}
export interface GateDeps {
  envMode: AutoSendMode; dailyCap: number;
  judge: (i: JudgeInput) => Promise<JudgeResult>;
  isPaused: () => boolean;
  // #702 Punkt 1: der Ausschluss gilt nur noch für die AKTUELLE Nachrichtenrunde — der Runner
  // übergibt dazu sent_at der letzten Gastnachricht (null ohne Gastnachricht), siehe
  // lastInboundMessageSentAt() unten und draft-repository.ts threadHasHumanIntervention.
  hasHumanIntervention: (threadId: string, lastGuestMessageSentAt: string | null) => boolean;
  hasFailedSend: (threadId: string) => boolean;
  countAutoSentSince: (sinceIso: string) => number;
  canSend: (thread: MessageThread, messages: Message[]) => boolean;
  persistDecision: (draftId: string, d: AutoSendDecision, mode: AutoSendMode) => void;
  claim: (draftId: string) => boolean;
  send: (draftId: string, thread: MessageThread, body: string, sentBy: 'auto') => Promise<{ ok: true } | { ok: false; err: unknown }>;
  // #696: Zusagen-Task — nur aufgerufen, wenn der Entwurf sonst automatisch ginge
  // (wouldAutoWithPromiseTask), siehe unten.
  resolvePromiseTask: (i: PromiseTaskInput) => Promise<PromiseTaskResult>;
  // #697: Buchungsanfrage-Task — anders als resolvePromiseTask IMMER aufgerufen, sobald ein
  // Guesty-System-Post erkannt wurde (unabhängig davon, ob der Entwurf sonst automatisch ginge).
  resolveBookingRequestTask: (i: BookingRequestTaskInput) => Promise<BookingRequestTaskResult>;
  // #697: strukturiertes Zeitraum/Personen-Paar für den Task-Titel (booking-context.ts).
  resolveBookingPeriod: (thread: MessageThread) => { periodLabel: string | null; guestsCount: number | null };
  // #697: persistiert request_kind/platform_deadline_at am Draft — unabhängig vom Gate-Ergebnis.
  persistBookingRequest: (draftId: string, requestKind: 'inquiry' | 'request_to_book', platformDeadlineAt: string) => void;
}
export function realGateDeps(): GateDeps {
  return {
    envMode: config.autoSendMode, dailyCap: config.autoSendDailyCap,
    judge: (i) => judgeDraft(i),
    isPaused: () => getSchedulerState(PAUSE_KEY) === '1',
    hasHumanIntervention: threadHasHumanIntervention,
    hasFailedSend: threadHasFailedSend,
    countAutoSentSince,
    canSend: (thread, messages) => thread.source !== 'guesty' || resolveOutboundModuleType(messages) !== null,
    persistDecision: setAutoDecision,
    claim: claimDraftForSending,
    send: (id, thread, body, sentBy) => sendClaimedDraft(id, thread, body, sentBy),
    resolvePromiseTask: (i) => resolvePromiseTask(i),
    resolveBookingRequestTask: (i) => resolveBookingRequestTask(i),
    resolveBookingPeriod: (thread) => resolveBookingPeriod(thread),
    persistBookingRequest: setBookingRequestContext,
  };
}

/**
 * Gastnachrichten seit der letzten Host-Antwort (chronologisch).
 * Vorbedingung: `messages` liegt chronologisch aufsteigend vor (wie von
 * `getMessagesByThread` geliefert). `system`-Nachrichten werden ignoriert —
 * sie zählen weder als Host-Antwort-Grenze noch als Gastnachricht.
 */
export function guestMessagesSinceLastHost(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.direction === 'outbound') out.length = 0;
    else if (m.direction === 'inbound') out.push(m.body);
  }
  return out;
}

/**
 * Id der letzten Gastnachricht seit der letzten Host-Antwort (#696, Idempotenz-Schlüssel
 * für die Zusagen-Task-Anlage — siehe draft-repository.ts findExistingSmartTasksTaskId).
 * Dieselbe Reset-auf-outbound-Logik wie guestMessagesSinceLastHost, liefert aber die Id
 * der zuletzt gesehenen Gastnachricht statt aller Texte. null ohne Gastnachricht.
 */
export function lastInboundMessageId(messages: Message[]): string | null {
  let id: string | null = null;
  for (const m of messages) {
    if (m.direction === 'outbound') id = null;
    else if (m.direction === 'inbound') id = m.id;
  }
  return id;
}

/**
 * sent_at der letzten Gastnachricht (#702 Punkt 1, Thread-Ausschluss-Rundenscoping) —
 * dieselbe Reset-auf-outbound-Logik wie lastInboundMessageId, liefert aber den Zeitpunkt statt
 * der Id. Grenze für threadHasHumanIntervention: ein Eingriff (verworfener Draft/Feedback) zählt
 * nur, wenn er zu einem Draft der AKTUELLEN Runde gehört (Draft created_at nach diesem
 * Zeitpunkt). null ohne Gastnachricht — draft-repository.ts behandelt das konservativ wie
 * bisher (dauerhafte Sperre), da sich dann keine Runde bestimmen lässt.
 */
export function lastInboundMessageSentAt(messages: Message[]): string | null {
  let sentAt: string | null = null;
  for (const m of messages) {
    if (m.direction === 'outbound') sentAt = null;
    else if (m.direction === 'inbound') sentAt = m.sent_at;
  }
  return sentAt;
}

export async function runAutoSendGate(input: GateInput, deps: GateDeps = realGateDeps()): Promise<{ decision: AutoSendDecision; mode: AutoSendMode; sent: boolean }> {
  const mode = resolveAutoSendMode(deps.envMode, input.property.autoSend);
  if (mode === 'off') {
    // Spec 4/6: off → nichts weiter, auto_decision bleibt NULL (Verhalten wie heute) —
    // kein decide()-Aufruf, kein Persist, sonst landet jeder Entwurf eines off-Objekts
    // als „wait" in getAwaitingDrafts und damit im WhatsApp-Push.
    logger.debug({ draftId: input.draftId, threadId: input.thread.id }, 'auto-send: Modus off — keine Prüfung, kein Persist');
    return { decision: { decision: 'wait', reason: 'Auto-Send aus (Modus off)', category: null, flags: [] }, mode, sent: false };
  }

  let decision: AutoSendDecision;
  try {
    const guestMessages = guestMessagesSinceLastHost(input.messages);
    // #697/#702: mechanische Buchungsanfrage-Erkennung — pure, unabhängig vom Judge-Modell.
    // Läuft VOR dem Judge-Aufruf, damit Task-Anlage + Fristpersistenz unten unabhängig vom
    // Judge-Ausgang passieren können. Seit #702 durchsucht findOpenBookingRequest den GANZEN
    // Thread (nicht nur den System-Post direkt nach der letzten Gastnachricht) und ist deshalb
    // auch für Folgenachrichten einer noch offenen Anfrage aktiv (Fall Anika: ihre Antwort auf
    // unsere Rückfrage, mehrere Nachrichten nach dem ursprünglichen System-Post) — solange die
    // verknüpfte Reservierung/Inquiry nicht bestätigt ist (thread.reservation_status). Die
    // Task-Anlage unten bleibt idempotent über dieselbe systemMessageId (Migration 029/030):
    // bei einer Folgenachricht wird der bestehende Task wiedergefunden, nicht dupliziert.
    const bookingRequest = findOpenBookingRequest(input.messages, input.thread.reservation_status);

    const judge = await deps.judge({
      guestMessages, draft: input.body, voice: input.voice, facts: input.facts,
      bookingContext: input.bookingContext, guestName: input.thread.guest_name,
      guestLanguage: input.guestLanguage,
    });
    // Kategorie-Override: ein erkannter System-Post erzwingt 'buchungsanfrage' — unabhängig
    // davon, was (oder ob überhaupt) der Judge klassifiziert hat (Spec: "der Judge darf sie
    // zusätzlich erkennen", nicht muss). Bei technisch fehlgeschlagenem Judge bleibt die
    // Kategorie null (decide() meldet ohnehin 'Prüfung technisch fehlgeschlagen') — der Task
    // wird trotzdem unten angelegt, Micha braucht ihn unabhängig vom Judge-Ausfall.
    const effectiveJudge: JudgeResult =
      bookingRequest && judge.kind === 'verdict' && judge.verdict.category !== 'buchungsanfrage'
        ? { kind: 'verdict', verdict: { ...judge.verdict, category: 'buchungsanfrage' } }
        : judge;
    const isBookingRequest = !!bookingRequest || (judge.kind === 'verdict' && judge.verdict.category === 'buchungsanfrage');

    const mechanical = runMechanicalChecks(input.body, {
      knownDigitRuns: collectDigitRuns([...guestMessages, input.bookingContext ?? '']),
      guestLanguage: input.guestLanguage,
      isBookingRequest,
    });
    const baseInput: Omit<PolicyInput, 'promiseTask' | 'bookingTask'> = {
      mode, paused: deps.isPaused(), judge: effectiveJudge, mechanical,
      // #702 Punkt 1: nur ein Eingriff der AKTUELLEN Runde zählt — Grenze ist sent_at der
      // letzten Gastnachricht.
      threadHasHumanIntervention: deps.hasHumanIntervention(input.thread.id, lastInboundMessageSentAt(input.messages)),
      threadHasFailedSend: deps.hasFailedSend(input.thread.id),
      autoSentToday: deps.countAutoSentSince(startOfBerlinDayIso()),
      dailyCap: deps.dailyCap,
      canSend: deps.canSend(input.thread, input.messages),
    };
    const guestMessageId = lastInboundMessageId(input.messages);
    const lastGuestMessage = guestMessages[guestMessages.length - 1] ?? '';

    // #697: Buchungsanfrage-Task — IMMER versucht, sobald ein System-Post mechanisch erkannt
    // wurde (nicht nur, wenn der Entwurf sonst automatisch ginge — anders als #696, Micha
    // braucht den Task auch bei 'wait'). Frist wird unabhängig vom Gate-Ergebnis persistiert.
    let bookingTask: PolicyInput['bookingTask'] = null;
    if (bookingRequest) {
      deps.persistBookingRequest(input.draftId, bookingRequest.requestKind, bookingRequest.platformDeadlineAt);
      const { periodLabel, guestsCount } = deps.resolveBookingPeriod(input.thread);
      const result = await deps.resolveBookingRequestTask({
        draftId: input.draftId, threadId: input.thread.id, systemMessageId: bookingRequest.systemMessageId,
        requestKind: bookingRequest.requestKind, platformDeadlineAt: bookingRequest.platformDeadlineAt,
        guestName: input.thread.guest_name, guestMessage: lastGuestMessage, draftBody: input.body,
        periodLabel, guestsCount, property: input.property, mode,
      });
      bookingTask = { created: result.created, taskNumber: result.taskNumber, deadlineLabel: formatBerlinDeadline(bookingRequest.platformDeadlineAt) };
    }

    // #696: Zusagen-Task — die (async) SmartTasks-Anlage lohnt sich nur, wenn der Entwurf
    // SONST automatisch ginge (alle anderen Gates schon grün). wouldAutoWithPromiseTask ist
    // pure (kein I/O) und prüft genau das vorab, bevor überhaupt ein API-Aufruf passiert.
    // Kategorie 'buchungsanfrage' läuft ohnehin nie in diese Fastlane (eigener Policy-Zweig).
    let promiseTask: PolicyInput['promiseTask'] = null;
    if (effectiveJudge.kind === 'verdict' && effectiveJudge.verdict.promisedAction && wouldAutoWithPromiseTask(baseInput)) {
      const result = await deps.resolvePromiseTask({
        draftId: input.draftId, threadId: input.thread.id, guestMessageId,
        guestName: input.thread.guest_name, guestMessage: lastGuestMessage, draftBody: input.body,
        promisedAction: effectiveJudge.verdict.promisedAction, property: input.property, mode,
      });
      promiseTask = { created: result.created, taskNumber: result.taskNumber };
    }
    decision = decide({ ...baseInput, promiseTask, bookingTask });
  } catch (err) {
    // Spec 8: Prüfmodell/Deps fehlerhaft → wait statt Exception, sonst bleibt
    // auto_decision NULL (kein Push, kein Ampel-Grund).
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ draftId: input.draftId, threadId: input.thread.id, err: msg }, 'auto-send: Prüfung fehlgeschlagen, werte als wait');
    decision = { decision: 'wait', reason: `Prüfung technisch fehlgeschlagen: ${msg}`, category: null, flags: [] };
  }
  if (input.attempt === 2) {
    // #695 Spec Punkt 3: beide Versuche protokollieren — der auto_reason des Neuversuchs nennt
    // "Neuversuch", damit im Ampel-/Board-Blick nachvollziehbar bleibt, dass hier bereits ein
    // zweiter Anlauf lief.
    decision = { ...decision, reason: `Neuversuch: ${decision.reason}` };
  }
  deps.persistDecision(input.draftId, decision, mode);
  logger.info({ draftId: input.draftId, threadId: input.thread.id, mode, decision: decision.decision, reason: decision.reason, flags: decision.flags }, 'auto-send: Entscheidung');

  if (mode !== 'live' || decision.decision !== 'auto') return { decision, mode, sent: false };
  if (!deps.claim(input.draftId)) {
    // Final-Review F3: Claim verloren (z. B. Prozess-Crash zwischen zwei Läufen) darf den
    // Entwurf nicht stillschweigend auf auto_decision='auto' stehen lassen — sonst blockiert
    // er neue Entwürfe im Thread (pending-Invariante) und taucht nirgends im Push/UI auf.
    // Sofort als wait nachpersistieren, damit /drafts/awaiting ihn zeigt.
    logger.warn({ draftId: input.draftId }, 'auto-send: Claim fehlgeschlagen');
    decision = { decision: 'wait', reason: 'Entwurf konnte nicht für den Versand reserviert werden', category: decision.category, flags: decision.flags };
    deps.persistDecision(input.draftId, decision, mode);
    return { decision, mode, sent: false };
  }
  const result = await deps.send(input.draftId, input.thread, input.body, 'auto');
  if (!result.ok) logger.error({ draftId: input.draftId, err: result.err instanceof Error ? result.err.message : String(result.err) }, 'auto-send: Versand fehlgeschlagen');
  return { decision, mode, sent: result.ok };
}
