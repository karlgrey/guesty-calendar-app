/**
 * Sync Guesty conversations + posts into our message_threads + messages tables.
 *
 * Strategy:
 * 1. Paginate /v1/communication/conversations (Deep: komplett; Poll: inkrementell, s. fetchConversationsIncremental)
 * 2. Filter to conversations where any reservation has listing_id == this property
 * 3. For each: fetch /posts, map to our schema, upsert (classification deferred to classify-threads.ts)
 *
 * Idempotent: re-runs are safe (upsert by id).
 */

import { guestyClient, diffRequestCounters, type GuestyRequestCounters } from '../services/guesty-client.js';
import {
  upsertThread,
  upsertMessage,
  getThreadById,
  getGuestyThreadsForListing,
  type GuestyListingThreadRow,
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
  /** Anzahl listConversationPosts-Calls dieses Aufrufs. */
  postsFetched?: number;
  /** Davon Threads aus dem lokalen Fenster (nicht in der Teil-Liste). */
  localWindowFetched?: number;
  /** Prozessweite Zähler-Differenz über die Dauer dieses Aufrufs (enthält parallele Calls anderer Jobs). */
  guestyRequests?: GuestyRequestCounters;
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

const LIST_PAGE_LIMIT = 50;

/** Komplette Kontoliste (Deep-Sync) inkl. Seitenzahl. */
export async function fetchAllConversationsWithStats(): Promise<{ conversations: any[]; pages: number }> {
  const all: any[] = [];
  let cursor = '';
  let page = 0;
  while (true) {
    page++;
    const { conversations, nextCursor } = await guestyClient.listConversations({
      limit: 100,
      cursorAfter: cursor || undefined,
    });
    all.push(...conversations);
    if (!nextCursor || conversations.length === 0) break;
    cursor = nextCursor;
    if (page > LIST_PAGE_LIMIT) {
      logger.warn({ page, total: all.length }, 'Guesty conversations: page limit hit, stopping');
      break;
    }
  }
  return { conversations: all, pages: page };
}

export async function fetchAllConversations(): Promise<any[]> {
  return (await fetchAllConversationsWithStats()).conversations;
}

/**
 * Inkrementelle Liste für den Poll: die Liste ist nach createdAt sortiert (neueste vorn), hat
 * aber kein Aktivitätsfeld. Wir blättern nur so weit, bis eine Seite alte Konversationen
 * (createdAt < now − INCREMENTAL_ACTIVE_WINDOW_DAYS) enthält UND alle diese alten lokal bekannt
 * sind — eine unbekannte alte Konversation heißt „nicht synchron" → weiterblättern.
 * Fehlendes/unparsebares createdAt zählt nicht als alt (konservativ). complete=true nur, wenn
 * bis zum Ende geblättert wurde; sonst ist die Liste partiell (→ syncGuesty mit partialList).
 */
export async function fetchConversationsIncremental(
  opts: { isKnown?: (convId: string) => boolean; now?: Date } = {},
): Promise<{ conversations: any[]; pages: number; complete: boolean }> {
  const isKnown = opts.isKnown ?? ((id: string) => getThreadById(`guesty:${id}`) !== null);
  const cutoff = (opts.now ?? new Date()).getTime() - INCREMENTAL_ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
  const all: any[] = [];
  let cursor = '';
  let page = 0;
  while (true) {
    page++;
    const { conversations, nextCursor } = await guestyClient.listConversations({
      limit: 100,
      cursorAfter: cursor || undefined,
    });
    all.push(...conversations);
    if (!nextCursor || conversations.length === 0) return { conversations: all, pages: page, complete: true };
    const times = conversations
      .map((c) => (c?.createdAt ? Date.parse(c.createdAt) : NaN))
      .filter((t) => !Number.isNaN(t));
    // Schutz (Prüfer #772): die Abbruchregel setzt „neueste vorn" voraus — die Sortierung ist
    // nicht per Parameter erzwingbar (Spike 19.09.2026). Ist die Seite nicht absteigend sortiert,
    // nie abbrechen (sonst bliebe die Teil-Liste bei den ältesten Konversationen hängen und der
    // Poll sähe neue Konversationen nie), sondern zu Ende blättern wie der Deep-Sync.
    const descending = times.every((t, i) => i === 0 || t <= times[i - 1]);
    if (!descending) {
      logger.warn({ page }, 'Guesty conversations: Seite nicht absteigend nach createdAt — blättere komplett');
    }
    const old = conversations.filter((c) => {
      const t = c?.createdAt ? Date.parse(c.createdAt) : NaN;
      return !Number.isNaN(t) && t < cutoff;
    });
    if (descending && old.length > 0 && old.every((c) => isKnown(c._id))) {
      return { conversations: all, pages: page, complete: false };
    }
    cursor = nextCursor;
    if (page > LIST_PAGE_LIMIT) {
      logger.warn({ page, total: all.length }, 'Guesty conversations: page limit hit, stopping');
      return { conversations: all, pages: page, complete: false };
    }
  }
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
 *
 * Kleine Fenster (#772): der Webhook ist der Primärweg, der Poll nur Sicherheitsnetz.
 * Threads außerhalb dieser Fenster holt nur der nächtliche Deep-Sync.
 */
export const INCREMENTAL_ACTIVE_WINDOW_DAYS = 7;
export const STAY_GRACE_DAYS = 3;

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

/**
 * Lokale Variante des Gates für Threads, die NICHT in der (Teil-)Liste stehen: Aktivitätsfenster
 * über last_message_at ODER ein bekannter Check-out (raw_meta.checkOuts bzw. Reservierung)
 * ≥ now − STAY_GRACE_DAYS (künftige Aufenthalte zählen also).
 */
export function isLocalThreadInWindow(
  thread: { last_message_at: string; raw_meta: string | null },
  reservationCheckOut: string | null,
  now: Date = new Date(),
): boolean {
  const activeCutoff = now.getTime() - INCREMENTAL_ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
  if (Date.parse(thread.last_message_at) > activeCutoff) return true;
  const graceCutoff = now.getTime() - STAY_GRACE_DAYS * 24 * 3600 * 1000;
  const candidates: unknown[] = [reservationCheckOut];
  if (thread.raw_meta) {
    try {
      const meta = JSON.parse(thread.raw_meta);
      if (Array.isArray(meta?.checkOuts)) candidates.push(...meta.checkOuts);
    } catch {
      /* kaputtes raw_meta → ignorieren */
    }
  }
  return candidates.some((c) => {
    if (typeof c !== 'string') return false;
    const t = Date.parse(c);
    return !Number.isNaN(t) && t >= graceCutoff;
  });
}

interface PostFetchTarget {
  convId: string;
  /** Aus der API-Konversation (Liste/Webhook) oder aus der lokalen Zeile (Fenster-Threads). */
  thread: Omit<NewMessageThread, 'first_message_at' | 'last_message_at' | 'message_count' | 'last_synced_at'> & {
    fallbackFirst: string;
    fallbackLast: string;
  };
  guestName: string | null;
}

/** Gemeinsamer Schreibpfad: Thread-Upsert mit aus den Posts berechneten Zeiten/Zähler + Nachrichten-Upsert. */
function persistThreadWithPosts(target: PostFetchTarget, posts: any[], now: string): number {
  const sortedTimes = posts
    .map((p: any) => p.createdAt)
    .filter(Boolean)
    .sort();
  const { fallbackFirst, fallbackLast, ...base } = target.thread;
  upsertThread({
    ...base,
    first_message_at: sortedTimes[0] ?? fallbackFirst,
    last_message_at: sortedTimes[sortedTimes.length - 1] ?? fallbackLast,
    message_count: posts.length,
    last_synced_at: now,
  });
  for (const post of posts) {
    const msg: NewMessage = {
      id: `guesty:${post._id}`,
      thread_id: target.thread.id,
      direction: mapDirection(post.sentBy),
      sent_at: post.createdAt ?? now,
      from_name: post.sentBy === 'host' ? 'host' : target.guestName,
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
  }
  return posts.length;
}

function targetFromConversation(conv: any, listingId: string): PostFetchTarget {
  const reservations = conv.meta?.reservations ?? [];
  const primaryRes = reservations[0] ?? null;
  const checkOuts = reservations
    .map((r: any) => r?.checkOut)
    .filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
  return {
    convId: conv._id,
    guestName: conv.meta?.guest?.fullName ?? null,
    thread: {
      id: `guesty:${conv._id}`,
      listing_id: listingId,
      source: 'guesty',
      channel: mapChannel(primaryRes?.source),
      guest_name: conv.meta?.guest?.fullName ?? null,
      guest_email: null, // Guesty does not expose guest email on conversation
      reservation_id: primaryRes?._id ?? null,
      inquiry_id: primaryRes?._id ?? null,
      reservation_status: primaryRes?.status ?? null,
      conversion_category: null,
      classification_confidence: null,
      classification_keywords: null,
      raw_meta: JSON.stringify({
        assignee: conv.assignee,
        priority: conv.priority,
        state: conv.state,
        guestIsReturning: conv.meta?.guest?.isReturning,
        checkOuts,
      }),
      // Date bounds — fall back to conv.createdAt
      fallbackFirst: conv.createdAt,
      fallbackLast: conv.createdAt,
    },
  };
}

function targetFromLocalRow(row: GuestyListingThreadRow): PostFetchTarget {
  return {
    convId: row.id.replace(/^guesty:/, ''),
    guestName: row.guest_name,
    thread: {
      id: row.id,
      listing_id: row.listing_id,
      source: 'guesty',
      channel: row.channel,
      guest_name: row.guest_name,
      guest_email: row.guest_email,
      reservation_id: row.reservation_id,
      inquiry_id: row.inquiry_id,
      reservation_status: row.reservation_status,
      conversion_category: null, // upsert behält bestehende Klassifikation bei NULL
      classification_confidence: null,
      classification_keywords: null,
      raw_meta: row.raw_meta,
      fallbackFirst: row.first_message_at,
      fallbackLast: row.last_message_at,
    },
  };
}

export async function syncGuestyMessagesForProperty(
  property: PropertyConfig,
  /**
   * Optional pre-fetched account-wide conversation list. Pass ONE list across
   * all guesty property passes in a run so the paginated fetch happens once.
   */
  prefetchedConversations?: any[],
  /** deep=true (forced ETL): fetch ALL conversations' posts, no incremental skip. */
  opts: {
    deep?: boolean;
    /**
     * Die übergebene Liste ist nur eine Teil-Liste (fetchConversationsIncremental, complete=false):
     * zusätzlich werden lokale Fenster-Threads dieses Listings geholt, die nicht in der Liste stehen.
     */
    partialList?: boolean;
    /** Schon in diesem Loop-Lauf gesyncte Konversationen (Vormerkliste) — weder aus Liste noch lokal nochmal holen. */
    excludeConvIds?: Set<string>;
  } = {},
): Promise<GuestyMessageSyncResult> {
  const start = Date.now();
  const countersBefore = guestyClient.getRequestCounters();
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
    const excluded = opts.excludeConvIds;
    const propertyConvs = allConvs.filter((c) =>
      !excluded?.has(c._id) &&
      (c.meta?.reservations ?? []).some(
        (r: any) => r.listing?._id === listingId || r.listingId === listingId,
      ),
    );

    let postsUpserted = 0;
    const now = new Date().toISOString();

    // Incremental gate (skip unchanged), then fetch all post lists CONCURRENTLY. Der Client-
    // Limiter (10/s + 100/min) glättet den Burst.
    const toFetch = opts.deep
      ? propertyConvs
      : propertyConvs.filter((conv) => shouldDeepFetchConversation(conv, getThreadById(`guesty:${conv._id}`)));
    const skippedUnchanged = propertyConvs.length - toFetch.length;

    const targets: PostFetchTarget[] = toFetch.map((conv) => targetFromConversation(conv, listingId));

    // (b) Teil-Liste: lokale Fenster-Threads dieses Listings, die nicht in der Liste stehen — nur Posts.
    let localWindowFetched = 0;
    if (!opts.deep && opts.partialList) {
      const inList = new Set(propertyConvs.map((c) => `guesty:${c._id}`));
      const nowDate = new Date();
      for (const row of getGuestyThreadsForListing(listingId)) {
        if (inList.has(row.id) || excluded?.has(row.id.replace(/^guesty:/, ''))) continue;
        if (!isLocalThreadInWindow(row, row.reservation_check_out, nowDate)) continue;
        targets.push(targetFromLocalRow(row));
        localWindowFetched++;
      }
    }

    const fetched = await Promise.all(
      targets.map(async (target) => ({ target, posts: await guestyClient.listConversationPosts(target.convId, 200) })),
    );
    for (const { target, posts } of fetched) {
      postsUpserted += persistThreadWithPosts(target, posts, now);
    }
    const postsFetched = targets.length;

    const duration = Date.now() - start;
    const guestyRequests = diffRequestCounters(guestyClient.getRequestCounters(), countersBefore);
    logger.info(
      {
        slug,
        conversationsFetched: allConvs.length,
        threadsForProperty: propertyConvs.length,
        skippedUnchanged,
        deep: !!opts.deep,
        postsUpserted,
        postsFetched,
        localWindowFetched,
        partialList: !!opts.partialList,
        // Prozessweite Differenz — enthält auch parallel laufende andere Guesty-Calls.
        guestyRequests,
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
      postsFetched,
      localWindowFetched,
      guestyRequests,
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
