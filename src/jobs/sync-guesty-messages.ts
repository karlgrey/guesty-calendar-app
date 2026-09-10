/**
 * Sync Guesty conversations + posts into our message_threads + messages tables.
 *
 * Strategy:
 * 1. Paginate /v1/communication/conversations until exhausted
 * 2. Filter to conversations where any reservation has listing_id == this property
 * 3. For each: fetch /posts, map to our schema, upsert (classification deferred to classify-threads.ts)
 *
 * Idempotent: re-runs are safe (upsert by id).
 */

import { guestyClient } from '../services/guesty-client.js';
import {
  upsertThread,
  upsertMessage,
  getThreadById,
} from '../repositories/message-repository.js';
import logger from '../utils/logger.js';
import type { PropertyConfig } from '../config/properties.js';
import type {
  MessageChannel,
  NewMessage,
  NewMessageThread,
} from '../types/messages.js';

export interface GuestyMessageSyncResult {
  success: boolean;
  conversationsFetched: number;
  threadsForProperty: number;
  postsUpserted: number;
  skippedUnchanged: number;
  durationMs: number;
  error?: string;
}

// Guesty channel discriminators → our normalized channel taxonomy.
function mapChannel(source: string | undefined): MessageChannel {
  if (!source) return 'other';
  const s = source.toLowerCase();
  if (s === 'airbnb' || s === 'airbnb2') return 'airbnb';
  if (s === 'booking.com' || s === 'bookingcom') return 'booking.com';
  if (s.startsWith('vrbo')) return 'vrbo';
  if (s === 'manual') return 'manual';
  if (s === 'landfolk') return 'landfolk';
  if (s === 'meetreet') return 'meetreet';
  return 'other';
}

function mapDirection(sentBy: string | undefined): 'inbound' | 'outbound' | 'system' {
  if (sentBy === 'guest') return 'inbound';
  if (sentBy === 'host') return 'outbound';
  return 'system'; // 'log' or anything else
}

export async function fetchAllConversations(): Promise<any[]> {
  const all: any[] = [];
  let cursor = '';
  let page = 0;
  while (true) {
    page++;
    const { conversations, nextCursor } = await guestyClient.listConversations({
      limit: 50,
      cursorAfter: cursor || undefined,
    });
    all.push(...conversations);
    if (!nextCursor || conversations.length === 0) break;
    cursor = nextCursor;
    if (page > 50) {
      logger.warn({ page, total: all.length }, 'Guesty conversations: page limit hit, stopping');
      break;
    }
  }
  return all;
}

/**
 * Incremental-sync gate: fetch a conversation's posts only when something can
 * have changed. Guestys conversation list has NO activity timestamp (and
 * state.read is useless for us — the Guesty inbox is never opened, everything
 * stays unread; the list sorts by createdAt, not activity). Signals:
 * unknown locally (must fetch) · local thread active within
 * INCREMENTAL_ACTIVE_WINDOW_DAYS · any reservation whose stay is upcoming or
 * ended less than STAY_GRACE_DAYS ago (guest messages cluster around the
 * stay). Everything else is skipped; the daily FORCED ETL (deep=true) does a
 * full pass and catches the rare late message on a long-finished stay.
 */
export const INCREMENTAL_ACTIVE_WINDOW_DAYS = 30;
export const STAY_GRACE_DAYS = 14;

export function shouldDeepFetchConversation(
  conv: any,
  localThread: { last_message_at: string } | null,
  now: Date = new Date(),
): boolean {
  if (!localThread) return true;
  const activeCutoff = now.getTime() - INCREMENTAL_ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
  if (Date.parse(localThread.last_message_at) > activeCutoff) return true;
  const graceCutoff = now.getTime() - STAY_GRACE_DAYS * 24 * 3600 * 1000;
  for (const r of conv?.meta?.reservations ?? []) {
    const checkOut = r?.checkOut ? Date.parse(r.checkOut) : NaN;
    if (!Number.isNaN(checkOut) && checkOut >= graceCutoff) return true;
  }
  return false;
}

export async function syncGuestyMessagesForProperty(
  property: PropertyConfig,
  /**
   * Optional pre-fetched account-wide conversation list. Pass ONE list across
   * all guesty property passes in a run so the paginated fetch happens once.
   */
  prefetchedConversations?: any[],
  /** deep=true (forced ETL): fetch ALL conversations' posts, no incremental skip. */
  opts: { deep?: boolean } = {},
): Promise<GuestyMessageSyncResult> {
  const start = Date.now();
  const slug = property.slug;
  const listingId = property.guestyPropertyId;

  if (!listingId) {
    return {
      success: false,
      conversationsFetched: 0,
      threadsForProperty: 0,
      postsUpserted: 0,
      skippedUnchanged: 0,
      durationMs: 0,
      error: 'No guestyPropertyId on property',
    };
  }

  try {
    logger.info({ slug }, 'Guesty messages: starting sync');
    const allConvs = prefetchedConversations ?? (await fetchAllConversations());

    // Filter to this listing
    const propertyConvs = allConvs.filter((c) =>
      (c.meta?.reservations ?? []).some(
        (r: any) => r.listing?._id === listingId || r.listingId === listingId,
      ),
    );

    let postsUpserted = 0;
    const now = new Date().toISOString();

    // Incremental gate (skip unchanged), then fetch all post lists CONCURRENTLY —
    // the client's Bottleneck limiter caps at 10 in flight; sequential awaits
    // would idle the limiter and take ~0.5s per conversation.
    const toFetch = opts.deep
      ? propertyConvs
      : propertyConvs.filter((conv) => shouldDeepFetchConversation(conv, getThreadById(`guesty:${conv._id}`)));
    const skippedUnchanged = propertyConvs.length - toFetch.length;

    const fetched = await Promise.all(
      toFetch.map(async (conv) => ({ conv, posts: await guestyClient.listConversationPosts(conv._id, 200) })),
    );

    for (const { conv, posts } of fetched) {
      const convId = conv._id;
      const threadId = `guesty:${convId}`;

      const reservations = conv.meta?.reservations ?? [];
      const primaryRes = reservations[0] ?? null;
      const reservationStatus = primaryRes?.status ?? null;

      // Date bounds — fall back to conv.createdAt
      const sortedTimes = posts
        .map((p: any) => p.createdAt)
        .filter(Boolean)
        .sort();
      const firstAt = sortedTimes[0] ?? conv.createdAt;
      const lastAt = sortedTimes[sortedTimes.length - 1] ?? conv.createdAt;

      const thread: NewMessageThread = {
        id: threadId,
        listing_id: listingId,
        source: 'guesty',
        channel: mapChannel(primaryRes?.source),
        guest_name: conv.meta?.guest?.fullName ?? null,
        guest_email: null, // Guesty does not expose guest email on conversation
        first_message_at: firstAt,
        last_message_at: lastAt,
        message_count: posts.length,
        reservation_id: primaryRes?._id ?? null,
        inquiry_id: primaryRes?._id ?? null,
        reservation_status: reservationStatus,
        conversion_category: null,
        classification_confidence: null,
        classification_keywords: null,
        raw_meta: JSON.stringify({
          assignee: conv.assignee,
          priority: conv.priority,
          state: conv.state,
          guestIsReturning: conv.meta?.guest?.isReturning,
        }),
        last_synced_at: now,
      };
      upsertThread(thread);

      for (const post of posts) {
        const msg: NewMessage = {
          id: `guesty:${post._id}`,
          thread_id: threadId,
          direction: mapDirection(post.sentBy),
          sent_at: post.createdAt ?? now,
          from_name: post.sentBy === 'host' ? 'host' : conv.meta?.guest?.fullName ?? null,
          from_address: null,
          to_address: null,
          subject: null,
          body: post.body ?? '',
          body_html: null,
          source: 'guesty',
          raw_meta: JSON.stringify({
            type: post.module?.type,
            externalId: post.module?.externalId,
            isFromMigration: post.isFromMigration,
          }),
        };
        upsertMessage(msg);
        postsUpserted++;
      }
    }

    const duration = Date.now() - start;
    logger.info(
      {
        slug,
        conversationsFetched: allConvs.length,
        threadsForProperty: propertyConvs.length,
        skippedUnchanged,
        deep: !!opts.deep,
        postsUpserted,
        duration,
      },
      'Guesty messages: sync completed',
    );

    return {
      success: true,
      conversationsFetched: allConvs.length,
      threadsForProperty: propertyConvs.length,
      postsUpserted,
      skippedUnchanged,
      durationMs: duration,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ slug, error: errMsg }, 'Guesty messages: sync failed');
    return {
      success: false,
      conversationsFetched: 0,
      threadsForProperty: 0,
      postsUpserted: 0,
      skippedUnchanged: 0,
      durationMs: Date.now() - start,
      error: errMsg,
    };
  }
}
