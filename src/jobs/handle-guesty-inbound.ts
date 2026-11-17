// Verarbeitungskette für eine einzelne eingehende Guesty-Webhook-Nachricht (Spec 3.1):
// Konversation immer per API nachladen (Payload wird nie direkt persistiert), passendes
// Objekt anhand der Listing-Id finden, nur dieses Objekt syncen (deep, wegen fehlender
// Guest-Namen bei reinen Anfragen), dann Draft-Generierung auf genau diesen Thread
// beschränken.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { guestyClient } from '../services/guesty-client.js';
import { syncGuestyMessagesForProperty } from './sync-guesty-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import { prefetchInquiryForThread } from './inquiry-prefetch.js';
import {
  acquireMessageSyncLock,
  messageSyncLock,
  addPendingGuestyConversation,
  findGuestyPropertyForConversation,
} from './message-loop.js';
import type { GuestyMessageWebhook } from '../routes/webhooks-guesty.js';
import logger from '../utils/logger.js';

export interface InboundDeps {
  getProperties: () => PropertyConfig[];
  getConversation: (id: string) => Promise<any>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<unknown>;
  generateDrafts: (p: PropertyConfig, onlyThreadIds: string[]) => Promise<unknown>;
  /** #1234: Einzelabruf der Anfragedaten, falls die inquiries-/reservations-Zeile fehlt. Wirft nie. */
  prefetchInquiry: (threadId: string) => Promise<unknown>;
}
const realDeps: InboundDeps = {
  getProperties: getAllProperties,
  getConversation: (id) => guestyClient.getConversation(id),
  syncGuesty: (p, convs) => syncGuestyMessagesForProperty(p, convs, { deep: true }),
  generateDrafts: (p, ids) => generateDraftsForProperty(p, undefined, { onlyThreadIds: ids }),
  prefetchInquiry: (threadId) => prefetchInquiryForThread(threadId),
};
/** Wartezeit auf den Nachrichten-Lock; der Loop-Lauf (Draft-Gen) kann Minuten dauern. */
export const WEBHOOK_LOCK_WAIT_MS = 120_000;

export async function handleGuestyInbound(payload: GuestyMessageWebhook, deps: InboundDeps = realDeps): Promise<void> {
  // Payload nie persistieren, Spec 3.1: die Konversation wird immer per API nachgeladen, damit
  // ein unvollständiges Webhook-Payload (fehlt z.B. meta.guest.fullName) nicht den bekannten
  // Gästenamen aus der DB überschreibt (Fix-Runde 1, Important #1).
  const conv = await deps.getConversation(payload.conversation._id);
  const property = findGuestyPropertyForConversation(conv, deps.getProperties());
  if (!property) { logger.warn({ conversationId: conv?._id }, 'guesty-webhook: kein Objekt passt — Poll fängt es'); return; }
  if (!(await acquireMessageSyncLock('webhook', WEBHOOK_LOCK_WAIT_MS))) {
    // Bereits geladene Konversation vormerken: der nächste Loop-Lauf synct sie zuerst (#772).
    addPendingGuestyConversation(conv);
    logger.info({ conversationId: conv._id }, 'guesty-webhook: Lock belegt — Konversation vorgemerkt, nächster Poll zuerst');
    return;
  }
  try {
    await deps.syncGuesty(property, [conv]);
    const threadId = `guesty:${conv._id}`;
    // #1234: Anfragedaten (Zeitraum, Personen, Preis) VOR Entwurf, Auto-Send-Gate und Task laden —
    // sonst fehlen sie bis zum nächsten Stunden-ETL. Non-fatal (prefetchInquiryForThread wirft nie;
    // der catch ist nur die Absicherung gegen eine fremde Dep).
    try {
      await deps.prefetchInquiry(threadId);
    } catch (err) {
      logger.warn({ threadId, err: err instanceof Error ? err.message : String(err) }, 'guesty-webhook: Einzelabruf fehlgeschlagen (non-fatal)');
    }
    await deps.generateDrafts(property, [threadId]);
  } finally {
    messageSyncLock.release('webhook');
  }
}
