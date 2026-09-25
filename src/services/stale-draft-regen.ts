/**
 * Stale-Draft-Regeneration (#699, 25.09.2026, Fall Farmhouse-Entwurf So→Mo)
 *
 * Ein KI-Entwurf, den Micha im Admin-UI öffnet (GET /admin/messages/:threadId), war teils
 * Stunden/Tage alt — ein Entwurf von So 15:34 wurde erst Mo gesendet, der Zeitbezug
 * ("schönen Sonntag") passte nicht mehr. Diese Funktion läuft VOR dem Rendern der
 * Thread-Ansicht und generiert einen zu alten pending-LLM-Entwurf still neu — DERSELBE
 * Datensatz (draftId bleibt gleich, siehe applyDraftRegeneration in draft-repository.ts),
 * anders als der "Neu generieren"-Button (POST /:threadId/regenerate), der verwirft + neu
 * anlegt. Migration: 032_add_draft_regeneration.sql.
 */
import { getMessagesByThread } from '../repositories/message-repository.js';
import { getActiveDraftByThread, claimDraftRegeneration, applyDraftRegeneration } from '../repositories/draft-repository.js';
import { getPropertyForThread } from '../utils/thread-property.js';
import { loadVoice, loadPropertyFacts } from './vault-knowledge.js';
import { generateDraftForThread, type DraftResult } from './draft-service.js';
import { buildBookingContext } from './booking-context.js';
import { findOpenBookingRequest } from './booking-request.js';
import { runAutoSendGate, type GateInput } from './auto-send/runner.js';
import type { AutoSendDecision, AutoSendMode } from './auto-send/types.js';
import { detectLanguage, type SupportedLanguage } from '../utils/language-detect.js';
import { lastInboundBody } from '../jobs/generate-drafts.js';
import { parseUtc } from '../utils/date.js';
import { config } from '../config/index.js';
import type { Message, MessageDraft, MessageThread } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export type StaleDraftRegenResult =
  | { kind: 'fresh' }
  | { kind: 'regenerated' }
  | { kind: 'failed'; reason: string }
  | { kind: 'skipped'; reason: string };

type GateResult = { decision: AutoSendDecision; mode: AutoSendMode; sent: boolean };

export interface StaleDraftRegenDeps {
  getActiveDraftByThread: (threadId: string) => MessageDraft | null;
  getMessages: (threadId: string) => Message[];
  getPropertyForThread: (thread: { source: string; listing_id: string | null }) => PropertyConfig | undefined;
  loadVoice: () => string | null;
  loadFacts: (vaultNote: string) => string | null;
  buildBookingContext: (thread: MessageThread) => string | null;
  generate: (input: {
    thread: MessageThread; messages: Message[]; voice: string; facts: string; bookingContext: string | null;
    guestLanguage?: SupportedLanguage; isBookingRequest?: boolean;
  }) => Promise<DraftResult>;
  claim: (draftId: string, staleHours: number) => boolean;
  apply: (draftId: string, newBody: string) => boolean;
  gate: (i: GateInput) => Promise<GateResult>;
  staleHours: number;
}

const realDeps: StaleDraftRegenDeps = {
  getActiveDraftByThread,
  getMessages: getMessagesByThread,
  getPropertyForThread,
  loadVoice: () => loadVoice(),
  loadFacts: (vaultNote) => loadPropertyFacts(vaultNote),
  buildBookingContext,
  generate: (input) => generateDraftForThread(input),
  claim: claimDraftRegeneration,
  apply: applyDraftRegeneration,
  gate: (i) => runAutoSendGate(i),
  staleHours: config.draftStaleHours,
};

/**
 * Referenzzeit fürs Entwurfs-Alter: die letzte ERFOLGREICHE Neugenerierung, sonst die
 * ursprüngliche Anlage (SQLite-UTC-Format "YYYY-MM-DD HH:MM:SS" bzw. ISO — parseUtc deckt
 * beides ab).
 */
function referenceTimeOf(draft: MessageDraft): string {
  return draft.regenerated_at ?? draft.created_at;
}

/** Gibt es eine Gastnachricht NACH der Referenzzeit? — dann ist der bestehende Draft-Pfad
 * (neue Gastnachricht löst ohnehin einen frischen Entwurf aus) zuständig, nicht diese Funktion. */
function hasNewerGuestMessage(messages: Message[], referenceTimeIso: string): boolean {
  const refMs = parseUtc(referenceTimeIso);
  return messages.some((m) => m.direction === 'inbound' && parseUtc(m.sent_at) > refMs);
}

export async function regenerateStaleDraftIfNeeded(
  thread: MessageThread,
  deps: StaleDraftRegenDeps = realDeps,
): Promise<StaleDraftRegenResult> {
  const draft = deps.getActiveDraftByThread(thread.id);
  if (!draft) return { kind: 'skipped', reason: 'kein aktiver Entwurf' };
  if (draft.generated_by !== 'llm') return { kind: 'skipped', reason: 'manueller Entwurf' };
  if (!['hostex', 'guesty'].includes(thread.source) || !thread.listing_id) {
    return { kind: 'skipped', reason: 'Quelle nicht hostex/guesty oder keine listing_id' };
  }

  const referenceTime = referenceTimeOf(draft);
  const ageMs = Date.now() - parseUtc(referenceTime);
  const staleMs = deps.staleHours * 60 * 60 * 1000;
  if (ageMs < staleMs) return { kind: 'fresh' };

  const messages = deps.getMessages(thread.id);
  if (hasNewerGuestMessage(messages, referenceTime)) {
    return { kind: 'skipped', reason: 'neue Gastnachricht seit Referenzzeit — bestehender Pfad zuständig' };
  }

  // Nicht in einen laufenden (Live-)Auto-Send-Claim reinfunken.
  if (draft.auto_decision === 'auto' && draft.auto_mode === 'live') {
    return { kind: 'skipped', reason: 'hängender Live-Auto-Send' };
  }

  if (!deps.claim(draft.id, deps.staleHours)) {
    return { kind: 'skipped', reason: 'schon versucht in diesem Fenster' };
  }

  const property = deps.getPropertyForThread(thread);
  const voice = deps.loadVoice();
  const facts = property?.vaultNote ? deps.loadFacts(property.vaultNote) : null;
  if (!property || !voice || !facts) {
    logger.warn({ threadId: thread.id, draftId: draft.id }, 'stale-draft-regen: Vault-Wissen fehlt (VAULT_PATH/vaultNote)');
    return { kind: 'failed', reason: 'Vault-Wissen fehlt' };
  }

  const bookingContext = deps.buildBookingContext(thread);
  const guestLanguage = detectLanguage(lastInboundBody(messages));
  const isBookingRequest = findOpenBookingRequest(messages, thread.reservation_status) !== null;

  let result: DraftResult;
  try {
    result = await deps.generate({ thread, messages, voice, facts, bookingContext, guestLanguage, isBookingRequest });
  } catch (err) {
    logger.warn({ threadId: thread.id, draftId: draft.id, err: err instanceof Error ? err.message : String(err) }, 'stale-draft-regen: Generierung fehlgeschlagen — alter Entwurf bleibt');
    return { kind: 'failed', reason: 'Generierung fehlgeschlagen' };
  }

  if (result.kind !== 'text') {
    // #385-Muster: kein markThreadAiNoReply — der bestehende (alte) Draft ist noch pending und
    // bleibt unangetastet, nur loggen. no_reply UND failed landen hier bewusst gleich (Spec).
    logger.warn({ threadId: thread.id, draftId: draft.id, result }, 'stale-draft-regen: kein verwertbarer Entwurf — alter Entwurf bleibt');
    return { kind: 'failed', reason: result.kind === 'no_reply' ? result.reason : result.error };
  }

  if (!deps.apply(draft.id, result.body)) {
    // Race: Draft wurde zwischen Claim und Anwenden gesendet/verworfen (status != 'pending').
    return { kind: 'skipped', reason: 'Entwurf inzwischen nicht mehr pending' };
  }

  // Gate läuft UNVERÄNDERT neu — im Modus 'live' kann er die neue Fassung also automatisch
  // versenden (dieselbe Kette wie bei einer frischen Generierung). Das ist gewollt, nicht
  // unterdrückt: setAutoDecision setzt auto_* (inkl. auto_judged_at) neu, ein Gate-Fehler wird
  // nur geloggt, nicht geworfen — die Neugenerierung selbst ist bereits erfolgreich.
  try {
    await deps.gate({ draftId: draft.id, body: result.body, thread, messages, voice, facts, bookingContext, property, guestLanguage });
  } catch (err) {
    logger.warn({ threadId: thread.id, draftId: draft.id, err: err instanceof Error ? err.message : String(err) }, 'stale-draft-regen: Gate fehlgeschlagen (Entwurf bleibt pending)');
  }

  return { kind: 'regenerated' };
}
