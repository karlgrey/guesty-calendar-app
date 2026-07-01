// src/jobs/hostex/sync-hostex-messages.ts
import { upsertThread, upsertMessage } from '../../repositories/message-repository.js';
import { mapHostexConversation } from '../../mappers/hostex/message-mapper.js';
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

    // Filter to conversations belonging to this property.
    // Hostex returns account-wide conversations; property_title in LIST items is the only
    // discriminator. Conversations with null/empty property_title are inquiries without a
    // resolvable property — not synced in Schnitt 1 (acceptable limitation).
    const convs = allConvs.filter(
      (conv) => conv.property_title && conv.property_title === property.name,
    );

    let threads = 0;
    let messages = 0;

    for (const conv of convs) {
      const detail = await client.getConversationDetails(conv.id);
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
