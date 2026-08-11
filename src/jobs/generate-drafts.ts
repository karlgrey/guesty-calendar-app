import { randomUUID } from 'node:crypto';
import { getThreadsNeedingDraft, getMessagesByThread, markThreadAiNoReply } from '../repositories/message-repository.js';
import { createDraft } from '../repositories/draft-repository.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread, DRAFT_MODEL, type DraftResult } from '../services/draft-service.js';
import { buildBookingContext } from '../services/booking-context.js';
import type { MessageThread, Message, NewDraft } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export const DRAFT_GEN_CAP = 10;
// Only draft threads whose last guest message is newer than this — stale threads
// don't warrant an AI reply. Expressed as a SQLite datetime modifier.
export const DRAFT_MAX_AGE_HOURS = 72;
export const DRAFT_SINCE_MODIFIER = `-${DRAFT_MAX_AGE_HOURS} hours`;

/**
 * Which message source + listing id a property's drafts are generated for.
 * airbnb-mail (and anything else without a reply channel) → null = no drafts.
 */
export function resolveDraftSource(
  property: PropertyConfig,
): { source: 'hostex' | 'guesty'; listingId: string } | null {
  if (property.provider === 'hostex' && property.hostexPropertyId) {
    return { source: 'hostex', listingId: property.hostexPropertyId };
  }
  if (property.provider === 'guesty' && property.guestyPropertyId) {
    return { source: 'guesty', listingId: property.guestyPropertyId };
  }
  return null;
}

export interface DraftGenDeps {
  getThreads: (source: 'hostex' | 'guesty', listingId: string, limit: number, sinceModifier: string) => MessageThread[];
  getMessages: (threadId: string) => Message[];
  loadVoice: () => string | null;
  loadFacts: (vaultNote: string) => string | null;
  generate: (input: { thread: MessageThread; messages: Message[]; voice: string; facts: string; bookingContext: string | null }) => Promise<DraftResult>;
  create: (d: NewDraft) => void;
  markNoReply: (threadId: string) => void;
  // #364: what the platform already knows about this thread's booking
  // (reservation/inquiry link) — see booking-context.ts.
  buildBookingContext: (thread: MessageThread) => string | null;
}

const realDeps: DraftGenDeps = {
  getThreads: getThreadsNeedingDraft,
  getMessages: getMessagesByThread,
  loadVoice: () => loadVoice(),
  loadFacts: (vaultNote) => loadPropertyFacts(vaultNote),
  generate: (input) => generateDraftForThread(input),
  create: createDraft,
  markNoReply: markThreadAiNoReply,
  buildBookingContext,
};

export async function generateDraftsForProperty(
  property: PropertyConfig,
  deps: DraftGenDeps = realDeps,
): Promise<{ generated: number; skipped: number }> {
  const target = resolveDraftSource(property);
  if (!target || !property.vaultNote) return { generated: 0, skipped: 0 };
  const voice = deps.loadVoice();
  const facts = deps.loadFacts(property.vaultNote);
  if (!voice || !facts) {
    logger.info({ slug: property.slug }, 'draft-gen: voice/facts missing — skipping');
    return { generated: 0, skipped: 0 };
  }

  const threads = deps.getThreads(target.source, target.listingId, DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER);
  let generated = 0;
  let skipped = 0;
  for (const thread of threads) {
    try {
      const bookingContext = deps.buildBookingContext(thread);
      const result = await deps.generate({ thread, messages: deps.getMessages(thread.id), voice, facts, bookingContext });
      if (result.kind === 'text') {
        deps.create({ id: randomUUID(), thread_id: thread.id, provider: target.source, body: result.body, generated_by: 'llm', model: DRAFT_MODEL });
        generated++;
      } else if (result.kind === 'no_reply') {
        // Bewusste Modell-Entscheidung "keine Antwort nötig" — merken, damit weder der
        // nächste Cron-Lauf noch die UI denselben Stand erneut ans Modell schicken.
        logger.info({ threadId: thread.id, reason: result.reason }, 'draft-gen: no reply needed');
        deps.markNoReply(thread.id);
        skipped++;
      } else {
        // Technischer Ausfall (Tool-Output fehlt/unbrauchbar) — KEIN markNoReply, damit der
        // nächste Lauf es erneut versucht statt den Thread dauerhaft auszuschließen (#385).
        logger.warn({ threadId: thread.id, error: result.error }, 'draft-gen: thread failed (technical)');
        skipped++;
      }
    } catch (err) {
      logger.warn({ threadId: thread.id, err: err instanceof Error ? err.message : String(err) }, 'draft-gen: thread failed');
      skipped++;
    }
  }
  logger.info({ slug: property.slug, generated, skipped }, 'draft-gen: done');
  return { generated, skipped };
}
