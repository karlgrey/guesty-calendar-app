// Eigener Nachrichten-Takt (Spec 3.2), unabhängig vom Stunden-ETL: Sync beider Provider →
// Entwürfe → Gate. Ein prozessweiter Lock verhindert überlappende Syncs mit dem ETL.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getHostexClient } from '../services/hostex-client.js';
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

export interface MessageLoopDeps {
  getProperties: () => PropertyConfig[];
  syncHostex: (p: PropertyConfig) => Promise<unknown>;
  fetchGuestyConversations: () => Promise<any[]>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<unknown>;
  generateDrafts: (p: PropertyConfig) => Promise<unknown>;
}

const realDeps: MessageLoopDeps = {
  getProperties: getAllProperties,
  syncHostex: (p) => syncHostexMessagesForProperty(p, getHostexClient(), undefined, undefined, { deep: false }),
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
  try {
    const props = deps.getProperties().filter((p) => p.provider === 'hostex' || p.provider === 'guesty');
    let guestyConvs: any[] | null = null;
    for (const p of props) {
      try {
        if (p.provider === 'hostex') {
          await deps.syncHostex(p);
        } else {
          guestyConvs ??= await deps.fetchGuestyConversations();
          await deps.syncGuesty(p, guestyConvs);
        }
        await deps.generateDrafts(p);
        count++;
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
