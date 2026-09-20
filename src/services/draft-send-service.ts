import type { MessageThread } from '../types/messages.js';
import { sendReply } from './message-sender.js';
import { markDraftSent, markDraftError } from '../repositories/draft-repository.js';
import { upsertMessage } from '../repositories/message-repository.js';

export interface SendDraftDeps {
  sendReply: typeof sendReply; markDraftSent: typeof markDraftSent; markDraftError: typeof markDraftError; upsertMessage: typeof upsertMessage;
}
const defaultDeps: SendDraftDeps = { sendReply, markDraftSent, markDraftError, upsertMessage };

/** Versand eines bereits per claimDraftForSending geclaimten Entwurfs (Freigabe-Klick ODER Auto-Send). */
export async function sendClaimedDraft(
  draftId: string, thread: MessageThread, bodyToSend: string, sentBy: 'micha' | 'auto', deps: SendDraftDeps = defaultDeps,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const { externalMessageId } = await deps.sendReply(thread, bodyToSend);
    deps.markDraftSent(draftId, externalMessageId, sentBy);
    // Key the local outbound row on the returned external id so the next sync that ingests
    // the same message as {source}:{realId} hits the same row (upsert = no-op) instead of
    // creating a duplicate. Falls back to sent:{draftId} when no external id is returned.
    // NOTE: this collapse assumes the send response's message id equals the id the
    // conversation later reports; confirm on first live send (hostex AND guesty).
    const outboundId = externalMessageId ? `${thread.source}:${externalMessageId}` : `sent:${draftId}`;
    deps.upsertMessage({
      id: outboundId, thread_id: thread.id, direction: 'outbound',
      sent_at: new Date().toISOString(), from_name: 'host', from_address: null, to_address: null,
      subject: null, body: bodyToSend, body_html: null, source: thread.source,
      raw_meta: JSON.stringify({ draftId, externalMessageId, sentBy }),
    });
    return { ok: true };
  } catch (sendErr) {
    deps.markDraftError(draftId, sendErr instanceof Error ? sendErr.message : String(sendErr));
    return { ok: false, err: sendErr };
  }
}
