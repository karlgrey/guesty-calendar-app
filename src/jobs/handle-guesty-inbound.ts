// Verarbeitungskette für eine einzelne eingehende Guesty-Webhook-Nachricht (Spec 3.1):
// passendes Objekt anhand der Listing-Id finden, nur dieses Objekt syncen (deep, wegen
// fehlender Guest-Namen bei reinen Anfragen), dann Draft-Generierung auf genau diesen
// Thread beschränken.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { guestyClient } from '../services/guesty-client.js';
import { syncGuestyMessagesForProperty } from './sync-guesty-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import { acquireMessageSyncLock, messageSyncLock } from './message-loop.js';
import type { GuestyMessageWebhook } from '../routes/webhooks-guesty.js';
import logger from '../utils/logger.js';

export interface InboundDeps {
  getProperties: () => PropertyConfig[];
  getConversation: (id: string) => Promise<any>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<unknown>;
  generateDrafts: (p: PropertyConfig, onlyThreadIds: string[]) => Promise<unknown>;
}
const realDeps: InboundDeps = {
  getProperties: getAllProperties,
  getConversation: (id) => guestyClient.getConversation(id),
  syncGuesty: (p, convs) => syncGuestyMessagesForProperty(p, convs, { deep: true }),
  generateDrafts: (p, ids) => generateDraftsForProperty(p, undefined, { onlyThreadIds: ids }),
};
const listingIdsOf = (conv: any): string[] => (conv?.meta?.reservations ?? []).map((r: any) => r?.listing?._id ?? r?.listingId).filter(Boolean);

export async function handleGuestyInbound(payload: GuestyMessageWebhook, deps: InboundDeps = realDeps): Promise<void> {
  let conv: any = payload.conversation;
  if (listingIdsOf(conv).length === 0) conv = await deps.getConversation(conv._id);
  const ids = listingIdsOf(conv);
  const property = deps.getProperties().find((p) => p.provider === 'guesty' && p.guestyPropertyId && ids.includes(p.guestyPropertyId));
  if (!property) { logger.warn({ conversationId: conv?._id, ids }, 'guesty-webhook: kein Objekt passt — Poll fängt es'); return; }
  if (!(await acquireMessageSyncLock('webhook', 30_000))) {
    logger.info({ conversationId: conv._id }, 'guesty-webhook: Lock belegt — Poll übernimmt');
    return;
  }
  try {
    await deps.syncGuesty(property, [conv]);
    await deps.generateDrafts(property, [`guesty:${conv._id}`]);
  } finally {
    messageSyncLock.release();
  }
}
