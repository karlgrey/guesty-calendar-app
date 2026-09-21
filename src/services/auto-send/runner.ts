// Orchestrierung des Gates (Spec 4 + 5): Entwurf liegt bereits als pending in message_drafts.
import { config } from '../../config/index.js';
import type { Message, MessageThread } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';
import { judgeDraft, type JudgeInput } from './judge-service.js';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';
import { decide, wouldAutoWithPromiseTask, type PolicyInput } from './policy.js';
import { resolveAutoSendMode } from './mode.js';
import { startOfBerlinDayIso } from './berlin-day.js';
import type { AutoSendDecision, AutoSendMode, JudgeResult } from './types.js';
import type { SupportedLanguage } from '../../utils/language-detect.js';
import { setAutoDecision, threadHasHumanIntervention, threadHasFailedSend, countAutoSentSince, claimDraftForSending } from '../../repositories/draft-repository.js';
import { getSchedulerState } from '../../repositories/scheduler-state-repository.js';
import { resolveOutboundModuleType } from '../guesty-channel.js';
import { sendClaimedDraft } from '../draft-send-service.js';
import { resolvePromiseTask, type PromiseTaskInput, type PromiseTaskResult } from '../promise-task-service.js';
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
  hasHumanIntervention: (threadId: string) => boolean;
  hasFailedSend: (threadId: string) => boolean;
  countAutoSentSince: (sinceIso: string) => number;
  canSend: (thread: MessageThread, messages: Message[]) => boolean;
  persistDecision: (draftId: string, d: AutoSendDecision, mode: AutoSendMode) => void;
  claim: (draftId: string) => boolean;
  send: (draftId: string, thread: MessageThread, body: string, sentBy: 'auto') => Promise<{ ok: true } | { ok: false; err: unknown }>;
  // #696: Zusagen-Task — nur aufgerufen, wenn der Entwurf sonst automatisch ginge
  // (wouldAutoWithPromiseTask), siehe unten.
  resolvePromiseTask: (i: PromiseTaskInput) => Promise<PromiseTaskResult>;
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
    const judge = await deps.judge({
      guestMessages, draft: input.body, voice: input.voice, facts: input.facts,
      bookingContext: input.bookingContext, guestName: input.thread.guest_name,
      guestLanguage: input.guestLanguage,
    });
    const mechanical = runMechanicalChecks(input.body, {
      knownDigitRuns: collectDigitRuns([...guestMessages, input.bookingContext ?? '']),
      guestLanguage: input.guestLanguage,
    });
    const baseInput: Omit<PolicyInput, 'promiseTask'> = {
      mode, paused: deps.isPaused(), judge, mechanical,
      threadHasHumanIntervention: deps.hasHumanIntervention(input.thread.id),
      threadHasFailedSend: deps.hasFailedSend(input.thread.id),
      autoSentToday: deps.countAutoSentSince(startOfBerlinDayIso()),
      dailyCap: deps.dailyCap,
      canSend: deps.canSend(input.thread, input.messages),
    };
    // #696: Zusagen-Task — die (async) SmartTasks-Anlage lohnt sich nur, wenn der Entwurf
    // SONST automatisch ginge (alle anderen Gates schon grün). wouldAutoWithPromiseTask ist
    // pure (kein I/O) und prüft genau das vorab, bevor überhaupt ein API-Aufruf passiert.
    let promiseTask: PolicyInput['promiseTask'] = null;
    if (judge.kind === 'verdict' && judge.verdict.promisedAction && wouldAutoWithPromiseTask(baseInput)) {
      const guestMessageId = lastInboundMessageId(input.messages);
      const lastGuestMessage = guestMessages[guestMessages.length - 1] ?? '';
      const result = await deps.resolvePromiseTask({
        draftId: input.draftId, threadId: input.thread.id, guestMessageId,
        guestName: input.thread.guest_name, guestMessage: lastGuestMessage, draftBody: input.body,
        promisedAction: judge.verdict.promisedAction, property: input.property, mode,
      });
      promiseTask = { created: result.created, taskNumber: result.taskNumber };
    }
    decision = decide({ ...baseInput, promiseTask });
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
