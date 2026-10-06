// Eigener Nachrichten-Takt (Spec 3.2), unabhängig vom Stunden-ETL: Sync beider Provider →
// Entwürfe → Gate. Ein prozessweiter Lock verhindert überlappende Syncs mit dem ETL.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getHostexClient, type HostexConversationDetail } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from './hostex/sync-hostex-messages.js';
import { syncGuestyMessagesForProperty, fetchConversationsIncremental } from './sync-guesty-messages.js';
import { guestyClient, diffRequestCounters, type GuestyRequestCounters } from '../services/guesty-client.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import logger from '../utils/logger.js';

export const messageSyncLock = {
  holder: null as string | null,
  tryAcquire(owner: string): boolean {
    if (this.holder) return false;
    this.holder = owner;
    return true;
  },
  // #686 Nachzieh-Liste: nur der aktuelle Halter darf freigeben — ohne Owner-Prüfung konnte ein
  // verspätetes finally (z. B. eines längst verworfenen Vorgangs) den Lock eines ANDEREN, in der
  // Zwischenzeit gestarteten Owners kappen und so zwei Läufe gleichzeitig auf dieselben Threads
  // loslassen. Fremder Owner → No-op + Warnung, Lock bleibt bestehen.
  release(owner: string): void {
    if (this.holder !== owner) {
      logger.warn(
        { owner, holder: this.holder },
        'message-loop: release() von falschem Owner ignoriert — Lock bleibt bestehen',
      );
      return;
    }
    this.holder = null;
  },
};

// Nur für Tests: erzwingt einen leeren Lock unabhängig vom aktuellen Owner (Test-Isolation
// zwischen Fällen, die den Lock mit unterschiedlichen Ownern belegen).
export function resetMessageSyncLockForTests(): void {
  messageSyncLock.holder = null;
}

/**
 * Wie tryAcquire, aber wartet bis zu maxWaitMs (in stepMs-Schritten) auf einen freien Lock,
 * statt sofort aufzugeben. Für den täglichen 2-Uhr-Deep-Sync (force=true, einziger Lauf des
 * Tages) darf der ETL-Nachrichtenschritt nicht schon deshalb ausfallen, weil der 5-Minuten-Loop
 * gerade eine LLM-Draft-Gen laufen hat (kann Minuten dauern). Berührt den Lock bei Timeout
 * nicht (tryAcquire setzt holder nur bei Erfolg).
 */
export async function acquireMessageSyncLock(
  owner: string,
  maxWaitMs: number,
  stepMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (!messageSyncLock.tryAcquire(owner)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
  return true;
}

/**
 * Vormerkliste (#772): Verliert der Webhook den Lock auch nach WEBHOOK_LOCK_WAIT_MS, ist die
 * bereits geladene Konversation sonst verloren (die Teil-Liste des Polls sieht sie womöglich
 * nicht mehr). Prozessweit; der nächste Loop-Lauf arbeitet sie nach dem Lock-Erwerb zuerst ab.
 */
const pendingGuestyConversations = new Map<string, any>();

export function addPendingGuestyConversation(conv: any): void {
  if (conv?._id) pendingGuestyConversations.set(conv._id, conv);
}
/** Gibt alle vorgemerkten Konversationen zurück und leert die Liste. */
export function takePendingGuestyConversations(): any[] {
  const all = [...pendingGuestyConversations.values()];
  pendingGuestyConversations.clear();
  return all;
}
export function pendingGuestyConversationCount(): number {
  return pendingGuestyConversations.size;
}
export function resetPendingGuestyConversationsForTests(): void {
  pendingGuestyConversations.clear();
}

const listingIdsOf = (conv: any): string[] =>
  (conv?.meta?.reservations ?? []).map((r: any) => r?.listing?._id ?? r?.listingId).filter(Boolean);

/** Passendes Guesty-Objekt zu einer Konversation per Listing-Id (Webhook + Vormerkliste). */
export function findGuestyPropertyForConversation(conv: any, props: PropertyConfig[]): PropertyConfig | undefined {
  const ids = listingIdsOf(conv);
  return props.find((p) => p.provider === 'guesty' && p.guestyPropertyId && ids.includes(p.guestyPropertyId));
}

export interface GuestySyncOpts {
  deep?: boolean;
  partialList?: boolean;
  /** Konversations-Ids, die in diesem Lauf schon gesynct wurden (Vormerkliste) — nicht nochmal holen. */
  excludeConvIds?: Set<string>;
}

export interface MessageLoopDeps {
  getProperties: () => PropertyConfig[];
  syncHostex: (p: PropertyConfig, cache: Map<string, HostexConversationDetail>) => Promise<{ success: boolean; error?: string }>;
  fetchGuestyConversations: () => Promise<{ conversations: any[]; pages: number; complete: boolean }>;
  syncGuesty: (p: PropertyConfig, convs: any[], opts: GuestySyncOpts) => Promise<{ success: boolean; error?: string }>;
  generateDrafts: (p: PropertyConfig) => Promise<unknown>;
  /** Prozessweite Guesty-HTTP-Zähler (Telemetrie je Lauf). */
  getRequestCounters?: () => GuestyRequestCounters;
}

const realDeps: MessageLoopDeps = {
  getProperties: getAllProperties,
  // Ein geteilter Detail-Cache pro Lauf über alle Hostex-Objekte hinweg (wie runMessageSync in
  // routes/messages.ts) — jede Conversation-Detail wird höchstens einmal je Lauf geholt.
  syncHostex: (p, cache) => syncHostexMessagesForProperty(p, getHostexClient(), undefined, cache, { deep: false }),
  fetchGuestyConversations: () => fetchConversationsIncremental(),
  syncGuesty: (p, convs, opts) => syncGuestyMessagesForProperty(p, convs, opts),
  generateDrafts: (p) => generateDraftsForProperty(p),
  getRequestCounters: () => guestyClient.getRequestCounters(),
};

export async function runMessageLoopOnce(
  deps: MessageLoopDeps = realDeps,
): Promise<{ skipped: boolean; properties: number }> {
  if (!messageSyncLock.tryAcquire('message-loop')) {
    logger.info({ holder: messageSyncLock.holder }, 'message-loop: Lock gehalten — Lauf übersprungen');
    return { skipped: true, properties: 0 };
  }
  const start = Date.now();
  const countersBefore = deps.getRequestCounters?.();
  let listPages = 0;
  let count = 0;
  const hostexDetailCache = new Map<string, HostexConversationDetail>();
  try {
    const props = deps.getProperties().filter((p) => p.provider === 'hostex' || p.provider === 'guesty');
    let guestyList: { conversations: any[]; pages: number; complete: boolean } | null = null;

    // Vormerkliste (Webhook hatte den Lock nicht) zuerst: nur deren Posts, keine Liste.
    const alreadySynced = new Set<string>();
    for (const conv of takePendingGuestyConversations()) {
      const prop = findGuestyPropertyForConversation(conv, props);
      if (!prop) {
        logger.warn({ conversationId: conv?._id }, 'message-loop: vorgemerkte Konversation ohne passendes Objekt — verworfen');
        continue;
      }
      try {
        const r = await deps.syncGuesty(prop, [conv], { deep: true });
        if (r.success) {
          alreadySynced.add(conv._id);
        } else {
          addPendingGuestyConversation(conv);
          logger.warn({ conversationId: conv._id, error: r.error }, 'message-loop: vorgemerkte Konversation fehlgeschlagen — wieder vorgemerkt');
        }
      } catch (err) {
        addPendingGuestyConversation(conv);
        logger.warn(
          { conversationId: conv._id, err: err instanceof Error ? err.message : String(err) },
          'message-loop: vorgemerkte Konversation fehlgeschlagen — wieder vorgemerkt',
        );
      }
    }

    for (const p of props) {
      try {
        let synced = true;
        if (p.provider === 'hostex') {
          const r = await deps.syncHostex(p, hostexDetailCache);
          if (!r.success) {
            synced = false;
            logger.warn({ slug: p.slug, error: r.error }, 'message-loop: Sync fehlgeschlagen');
          }
        } else {
          if (!guestyList) {
            guestyList = await deps.fetchGuestyConversations();
            listPages = guestyList.pages;
          }
          const r = await deps.syncGuesty(p, guestyList.conversations, {
            deep: false,
            partialList: !guestyList.complete,
            ...(alreadySynced.size > 0 ? { excludeConvIds: alreadySynced } : {}),
          });
          if (!r.success) {
            synced = false;
            logger.warn({ slug: p.slug, error: r.error }, 'message-loop: Sync fehlgeschlagen');
          }
        }
        // Draft-Gen läuft auch bei fehlgeschlagenem Sync — bereits vorhandene, ältere
        // Nachrichten können noch unbeantwortet sein.
        await deps.generateDrafts(p);
        if (synced) count++;
      } catch (err) {
        logger.error(
          { slug: p.slug, err: err instanceof Error ? err.message : String(err) },
          'message-loop: Objekt fehlgeschlagen (non-fatal)',
        );
      }
    }
  } finally {
    messageSyncLock.release('message-loop');
  }
  // guestyRequests = prozessweite Differenz (enthält auch parallel laufende Guesty-Calls, z. B. Webhooks).
  const guestyRequests =
    countersBefore && deps.getRequestCounters ? diffRequestCounters(deps.getRequestCounters(), countersBefore) : undefined;
  logger.info(
    { properties: count, durationMs: Date.now() - start, listPages, guestyRequests },
    'message-loop: Lauf beendet',
  );
  return { skipped: false, properties: count };
}

let timer: NodeJS.Timeout | null = null;

export function startMessageLoop(intervalMinutes: number): void {
  if (timer) return;
  const base = intervalMinutes * 60_000;
  const tick = () => {
    void runMessageLoopOnce().catch((err) => logger.error({ err }, 'message-loop: unerwarteter Fehler'));
    timer = setTimeout(tick, Math.floor(base * (0.9 + Math.random() * 0.2))); // Jitter ±10 %
  };
  timer = setTimeout(tick, 60_000); // 60 s nach Start
  logger.info({ intervalMinutes }, '💬 Nachrichten-Loop gestartet');
}

export function stopMessageLoop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
