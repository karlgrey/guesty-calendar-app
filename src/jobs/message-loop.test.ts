// src/jobs/message-loop.test.ts
//
// Nachrichten-Loop (Spec 3.2, Task 9): eigener 5-Minuten-Takt für Nachrichten-Sync +
// Draft-Gen, unabhängig vom Stunden-ETL. Prozessweiter Lock verhindert überlappende
// Syncs mit dem ETL (Task 10 nutzt denselben Lock für Webhooks).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messageSyncLock, runMessageLoopOnce, type MessageLoopDeps } from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';

const props = [
  { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'H1', vaultNote: 'b.md' },
  { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1', vaultNote: 'f.md' },
  { slug: 'florenz', provider: 'airbnb-mail' },
] as unknown as PropertyConfig[];

function deps(over: Partial<MessageLoopDeps> = {}): MessageLoopDeps {
  return {
    getProperties: () => props,
    syncHostex: vi.fn().mockResolvedValue(undefined),
    fetchGuestyConversations: vi.fn().mockResolvedValue([{ _id: 'c1' }]),
    syncGuesty: vi.fn().mockResolvedValue(undefined),
    generateDrafts: vi.fn().mockResolvedValue({ generated: 0, skipped: 0 }),
    ...over,
  };
}
beforeEach(() => messageSyncLock.release());

describe('runMessageLoopOnce', () => {
  it('synct Hostex- und Guesty-Objekte, Guesty-Liste nur einmal, dann Entwürfe', async () => {
    const d = deps();
    const r = await runMessageLoopOnce(d);
    expect(r).toEqual({ skipped: false, properties: 2 });
    expect(d.syncHostex).toHaveBeenCalledTimes(1);
    expect(d.fetchGuestyConversations).toHaveBeenCalledTimes(1);
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [{ _id: 'c1' }]);
    expect(d.generateDrafts).toHaveBeenCalledTimes(2);
  });
  it('überspringt, wenn der Lock gehalten wird', async () => {
    messageSyncLock.tryAcquire('etl');
    const d = deps();
    expect(await runMessageLoopOnce(d)).toEqual({ skipped: true, properties: 0 });
    expect(d.syncHostex).not.toHaveBeenCalled();
  });
  it('gibt den Lock auch bei Fehler frei', async () => {
    const d = deps({ syncHostex: vi.fn().mockRejectedValue(new Error('x')) });
    await runMessageLoopOnce(d);
    expect(messageSyncLock.holder).toBeNull();
  });
});
