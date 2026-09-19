// Eigener Nachrichten-Takt (Spec 3.2), unabhängig vom Stunden-ETL: Sync beider Provider →
// Entwürfe → Gate. Ein prozessweiter Lock verhindert überlappende Syncs mit dem ETL.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getHostexClient, type HostexConversationDetail } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from './hostex/sync-hostex-messages.js';
import { syncGuestyMessagesForProperty, fetchAllConversations } from './sync-guesty-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import logger from '../utils/logger.js';

export const messageSyncLock = {
  holder: null as string | null,
  tryAcquire(owner: string): boolean {
    if (this.holder) return false;
    this.holder = owner;
    return true;
  },
  release(): void {
    this.holder = null;
  },
};

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

export interface MessageLoopDeps {
  getProperties: () => PropertyConfig[];
  syncHostex: (p: PropertyConfig, cache: Map<string, HostexConversationDetail>) => Promise<{ success: boolean; error?: string }>;
  fetchGuestyConversations: () => Promise<any[]>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<{ success: boolean; error?: string }>;
  generateDrafts: (p: PropertyConfig) => Promise<unknown>;
}

const realDeps: MessageLoopDeps = {
  getProperties: getAllProperties,
  // Ein geteilter Detail-Cache pro Lauf über alle Hostex-Objekte hinweg (wie runMessageSync in
  // routes/messages.ts) — jede Conversation-Detail wird höchstens einmal je Lauf geholt.
  syncHostex: (p, cache) => syncHostexMessagesForProperty(p, getHostexClient(), undefined, cache, { deep: false }),
  fetchGuestyConversations: fetchAllConversations,
  syncGuesty: (p, convs) => syncGuestyMessagesForProperty(p, convs, { deep: false }),
  generateDrafts: (p) => generateDraftsForProperty(p),
};

export async function runMessageLoopOnce(
  deps: MessageLoopDeps = realDeps,
): Promise<{ skipped: boolean; properties: number }> {
  if (!messageSyncLock.tryAcquire('message-loop')) {
    logger.info({ holder: messageSyncLock.holder }, 'message-loop: Lock gehalten — Lauf übersprungen');
    return { skipped: true, properties: 0 };
  }
  const start = Date.now();
  let count = 0;
  const hostexDetailCache = new Map<string, HostexConversationDetail>();
  try {
    const props = deps.getProperties().filter((p) => p.provider === 'hostex' || p.provider === 'guesty');
    let guestyConvs: any[] | null = null;
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
          guestyConvs ??= await deps.fetchGuestyConversations();
          const r = await deps.syncGuesty(p, guestyConvs);
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
    messageSyncLock.release();
  }
  logger.info({ properties: count, durationMs: Date.now() - start }, 'message-loop: Lauf beendet');
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
