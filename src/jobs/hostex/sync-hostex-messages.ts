// src/jobs/hostex/sync-hostex-messages.ts
import { upsertThread, upsertMessage } from '../../repositories/message-repository.js';
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
  error?: string;
}

export async function syncHostexMessagesForProperty(
  property: PropertyConfig,
  client: HostexMessageClient,
  now: string = new Date().toISOString(),
): Promise<HostexMessageSyncResult> {
  const listingId = property.hostexPropertyId;
  if (!listingId) {
    return { success: false, threads: 0, messages: 0, error: 'No hostexPropertyId on property' };
  }

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

    for (const conv of candidates) {
      const detail = await client.getConversationDetails(conv.id);
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

    logger.info({ slug: property.slug, threads, messages }, 'Hostex: message sync done');
    return { success: true, threads, messages };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ slug: property.slug, err: msg }, 'Hostex: message sync failed');
    return { success: false, threads: 0, messages: 0, error: msg };
  }
}
