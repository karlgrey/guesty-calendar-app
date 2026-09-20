// Orchestrierung des Gates (Spec 4 + 5): Entwurf liegt bereits als pending in message_drafts.
import { config } from '../../config/index.js';
import type { Message, MessageThread } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';
import { judgeDraft, type JudgeInput } from './judge-service.js';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';
import { decide } from './policy.js';
import { resolveAutoSendMode } from './mode.js';
import { startOfBerlinDayIso } from './berlin-day.js';
import type { AutoSendDecision, AutoSendMode, JudgeResult } from './types.js';
import { setAutoDecision, threadHasHumanIntervention, threadHasFailedSend, countAutoSentSince, claimDraftForSending } from '../../repositories/draft-repository.js';
import { getSchedulerState } from '../../repositories/scheduler-state-repository.js';
import { resolveOutboundModuleType } from '../guesty-channel.js';
import { sendClaimedDraft } from '../draft-send-service.js';
import logger from '../../utils/logger.js';

export const PAUSE_KEY = 'auto_send_paused';

export interface GateInput {
  draftId: string; body: string; thread: MessageThread; messages: Message[];
  voice: string; facts: string; bookingContext: string | null; property: PropertyConfig;
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
    const judge = await deps.judge({ guestMessages, draft: input.body, voice: input.voice, facts: input.facts, bookingContext: input.bookingContext, guestName: input.thread.guest_name });
    const mechanical = runMechanicalChecks(input.body, { knownDigitRuns: collectDigitRuns([...guestMessages, input.bookingContext ?? '']) });
    decision = decide({
      mode, paused: deps.isPaused(), judge, mechanical,
      threadHasHumanIntervention: deps.hasHumanIntervention(input.thread.id),
      threadHasFailedSend: deps.hasFailedSend(input.thread.id),
      autoSentToday: deps.countAutoSentSince(startOfBerlinDayIso()),
      dailyCap: deps.dailyCap,
      canSend: deps.canSend(input.thread, input.messages),
    });
  } catch (err) {
    // Spec 8: Prüfmodell/Deps fehlerhaft → wait statt Exception, sonst bleibt
    // auto_decision NULL (kein Push, kein Ampel-Grund).
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ draftId: input.draftId, threadId: input.thread.id, err: msg }, 'auto-send: Prüfung fehlgeschlagen, werte als wait');
    decision = { decision: 'wait', reason: `Prüfung technisch fehlgeschlagen: ${msg}`, category: null, flags: [] };
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
