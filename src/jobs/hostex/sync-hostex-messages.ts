// src/jobs/hostex/sync-hostex-messages.ts
import { upsertThread, upsertMessage, getThreadById } from '../../repositories/message-repository.js';
import { mapHostexConversation, detailBelongsToProperty } from '../../mappers/hostex/message-mapper.js';
import type { HostexConversation, HostexConversationDetail } from '../../services/hostex-client.js';
import type { PropertyConfig } from '../../config/properties.js';
import logger from '../../utils/logger.js';

export interface HostexMessageClient {
  getConversations(o?: { limit?: number; offset?: number }): Promise<HostexConversation[]>;
  getConversationDetails(id: string): Promise<HostexConversationDetail>;
}

export interface HostexMessageSyncResult {
  success: boolean;
  threads: number;
  messages: number;
  skippedUnchanged: number;
  error?: string;
}

/**
 * Incremental-sync gate: the Hostex LIST carries last_message_at, so we can
 * skip the detail fetch exactly — a conversation only changed when its list
 * activity is newer than the local thread's last sync stamp. Unknown threads
 * and list items without the field are always fetched.
 */
export function shouldFetchHostexDetail(
  conv: { last_message_at?: string | null },
  localThread: { last_synced_at: string } | null,
): boolean {
  if (!localThread || !conv.last_message_at) return true;
  return Date.parse(conv.last_message_at) > Date.parse(localThread.last_synced_at);
}

export async function syncHostexMessagesForProperty(
  property: PropertyConfig,
  client: HostexMessageClient,
  now: string = new Date().toISOString(),
  /**
   * Optional per-run cache of conversation details keyed by conv id. Pass ONE
   * shared Map across all property passes in a run so each detail — especially
   * empty-title inquiries, which are candidates in every pass — is fetched once.
   */
  detailCache?: Map<string, HostexConversationDetail>,
  /** deep=true (täglicher Force-ETL): Details für ALLE Kandidaten, kein inkrementeller Skip. */
  opts: { deep?: boolean } = {},
): Promise<HostexMessageSyncResult> {
  const listingId = property.hostexPropertyId;
  if (!listingId) {
    return { success: false, threads: 0, messages: 0, skippedUnchanged: 0, error: 'No hostexPropertyId on property' };
  }

  const getDetail = async (id: string): Promise<HostexConversationDetail> => {
    const cached = detailCache?.get(id);
    if (cached) return cached;
    const detail = await client.getConversationDetails(id);
    detailCache?.set(id, detail);
    return detail;
  };

  try {
    const allConvs = await client.getConversations({ limit: 100 });

    // Hostex returns account-wide conversations. Candidates for THIS property are:
    //  - bookings, whose LIST item carries a matching property_title (cheap fast-path), and
    //  - inquiries, whose LIST item has an EMPTY property_title (Hostex omits it pre-booking)
    //    — these must be attributed via the DETAIL's numeric activities[].property.id.
    const candidates = allConvs.filter(
      (conv) => (conv.property_title && conv.property_title === property.name) || !conv.property_title,
    );

    let threads = 0;
    let messages = 0;
    let skippedUnchanged = 0;

    for (const conv of candidates) {
      if (!opts.deep && !shouldFetchHostexDetail(conv, getThreadById(`hostex:${conv.id}`))) {
        skippedUnchanged++;
        continue;
      }
      const detail = await getDetail(conv.id);
      // Empty-title candidates (inquiries) belong to another property unless the detail confirms.
      if (!conv.property_title && !detailBelongsToProperty(detail, listingId)) continue;
      const { thread, messages: msgs } = mapHostexConversation(detail, listingId, now);
      upsertThread(thread);
      for (const m of msgs) {
        upsertMessage(m);
        messages++;
      }
      threads++;
    }

    logger.info({ slug: property.slug, threads, messages, skippedUnchanged, deep: !!opts.deep }, 'Hostex: message sync done');
    return { success: true, threads, messages, skippedUnchanged };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ slug: property.slug, err: msg }, 'Hostex: message sync failed');
    return { success: false, threads: 0, messages: 0, skippedUnchanged: 0, error: msg };
  }
}
