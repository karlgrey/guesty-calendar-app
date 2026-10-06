// src/jobs/message-loop.test.ts
//
// Nachrichten-Loop (Spec 3.2, Task 9): eigener 5-Minuten-Takt für Nachrichten-Sync +
// Draft-Gen, unabhängig vom Stunden-ETL. Prozessweiter Lock verhindert überlappende
// Syncs mit dem ETL (Task 10 nutzt denselben Lock für Webhooks).
//
// Fix-Runde 1 (Review): acquireMessageSyncLock (ETL wartet statt sofort zu überspringen),
// Sync-Ergebnis wird ausgewertet (fehlgeschlagene Objekte zählen nicht als erledigt, Draft-Gen
// läuft trotzdem), Hostex-Detail-Cache wird pro Lauf geteilt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  messageSyncLock,
  runMessageLoopOnce,
  acquireMessageSyncLock,
  resetMessageSyncLockForTests,
  addPendingGuestyConversation,
  takePendingGuestyConversations,
  pendingGuestyConversationCount,
  resetPendingGuestyConversationsForTests,
  type MessageLoopDeps,
} from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

const props = [
  { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'H1', vaultNote: 'b.md' },
  { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1', vaultNote: 'f.md' },
  { slug: 'florenz', provider: 'airbnb-mail' },
] as unknown as PropertyConfig[];

function deps(over: Partial<MessageLoopDeps> = {}): MessageLoopDeps {
  return {
    getProperties: () => props,
    syncHostex: vi.fn().mockResolvedValue({ success: true }),
    fetchGuestyConversations: vi.fn().mockResolvedValue({ conversations: [{ _id: 'c1' }], pages: 1, complete: true }),
    syncGuesty: vi.fn().mockResolvedValue({ success: true }),
    generateDrafts: vi.fn().mockResolvedValue({ generated: 0, skipped: 0 }),
    ...over,
  };
}
beforeEach(() => { resetMessageSyncLockForTests(); resetPendingGuestyConversationsForTests(); });

describe('runMessageLoopOnce', () => {
  it('synct Hostex- und Guesty-Objekte, Guesty-Liste nur einmal, dann Entwürfe', async () => {
    const d = deps();
    const r = await runMessageLoopOnce(d);
    expect(r).toEqual({ skipped: false, properties: 2 });
    expect(d.syncHostex).toHaveBeenCalledTimes(1);
    expect(d.syncHostex).toHaveBeenCalledWith(props[0], expect.any(Map));
    expect(d.fetchGuestyConversations).toHaveBeenCalledTimes(1);
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [{ _id: 'c1' }], { deep: false, partialList: false });
    expect(d.generateDrafts).toHaveBeenCalledTimes(2);
  });
  it('Teil-Liste (complete=false) → partialList=true', async () => {
    const d = deps({ fetchGuestyConversations: vi.fn().mockResolvedValue({ conversations: [{ _id: 'c1' }], pages: 2, complete: false }) });
    await runMessageLoopOnce(d);
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [{ _id: 'c1' }], { deep: false, partialList: true });
  });
  it('loggt guestyRequests (Zähler-Differenz) und listPages', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation((() => {}) as any);
    const z = { total: 0, conversationList: 0, conversationPosts: 0, conversationGet: 0, other: 0, retries: 0, rateLimited429: 0 };
    const getRequestCounters = vi.fn().mockReturnValueOnce(z).mockReturnValueOnce({ ...z, total: 7, conversationPosts: 5, conversationList: 2 });
    const d = deps({ getRequestCounters, fetchGuestyConversations: vi.fn().mockResolvedValue({ conversations: [], pages: 3, complete: true }) });
    await runMessageLoopOnce(d);
    const call = info.mock.calls.find((c) => c[1] === 'message-loop: Lauf beendet');
    expect(call![0]).toMatchObject({ listPages: 3, guestyRequests: { total: 7, conversationPosts: 5, conversationList: 2 } });
    info.mockRestore();
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
  it('zählt ein Objekt mit fehlgeschlagenem Sync nicht mit, generiert aber trotzdem Entwürfe', async () => {
    const d = deps({ syncHostex: vi.fn().mockResolvedValue({ success: false, error: 'x' }) });
    const r = await runMessageLoopOnce(d);
    expect(r).toEqual({ skipped: false, properties: 1 }); // nur das Guesty-Objekt zählt
    expect(d.generateDrafts).toHaveBeenCalledTimes(2); // Draft-Gen trotzdem für beide
  });
  it('teilt den Hostex-Detail-Cache über alle Hostex-Objekte eines Laufs', async () => {
    const twoHostexProps = [
      { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'H1', vaultNote: 'b.md' },
      { slug: 'schilderwerkstatt', provider: 'hostex', hostexPropertyId: 'H2', vaultNote: 's.md' },
    ] as unknown as PropertyConfig[];
    const syncHostex = vi.fn().mockResolvedValue({ success: true });
    const d = deps({ getProperties: () => twoHostexProps, syncHostex });
    await runMessageLoopOnce(d);
    expect(syncHostex).toHaveBeenCalledTimes(2);
    const cache0 = syncHostex.mock.calls[0][1];
    const cache1 = syncHostex.mock.calls[1][1];
    expect(cache0).toBeInstanceOf(Map);
    expect(cache0).toBe(cache1);
  });
});

// #686 Nachzieh-Liste: release() nahm bisher jeden Aufrufer bedingungslos ab — ein Owner konnte
// so den Lock eines ANDEREN Owners freigeben (z. B. wenn ein bereits abgelaufener/verworfener
// Vorgang doch noch sein finally durchläuft, nachdem längst ein neuer Owner den Lock hält).
// release(owner) gibt nur noch frei, wenn owner tatsächlich der aktuelle Halter ist.
describe('messageSyncLock.release(owner) — Owner-Prüfung (#686)', () => {
  beforeEach(() => resetMessageSyncLockForTests());

  it('korrekter Owner gibt frei', () => {
    messageSyncLock.tryAcquire('etl');
    messageSyncLock.release('etl');
    expect(messageSyncLock.holder).toBeNull();
  });

  it('fremder Owner gibt NICHT frei — Lock bleibt beim echten Halter', () => {
    messageSyncLock.tryAcquire('etl');
    messageSyncLock.release('message-loop');
    expect(messageSyncLock.holder).toBe('etl');
  });

  it('Release auf freiem Lock ist ein No-op', () => {
    messageSyncLock.release('etl');
    expect(messageSyncLock.holder).toBeNull();
  });
});

describe('acquireMessageSyncLock', () => {
  beforeEach(() => {
    resetMessageSyncLockForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lock frei: sofort true', async () => {
    await expect(acquireMessageSyncLock('etl', 60_000)).resolves.toBe(true);
    expect(messageSyncLock.holder).toBe('etl');
  });

  it('lock belegt, wird nach 7s frei: true nach Warten', async () => {
    messageSyncLock.tryAcquire('message-loop');
    setTimeout(() => messageSyncLock.release('message-loop'), 7000);
    const resultPromise = acquireMessageSyncLock('etl', 60_000, 5000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(resultPromise).resolves.toBe(true);
    expect(messageSyncLock.holder).toBe('etl');
  });

  it('lock bleibt über maxWaitMs hinaus belegt: false, Lock wird nicht berührt', async () => {
    messageSyncLock.tryAcquire('message-loop');
    const resultPromise = acquireMessageSyncLock('etl', 60_000, 5000);
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(resultPromise).resolves.toBe(false);
    expect(messageSyncLock.holder).toBe('message-loop');
  });
});

describe('Vormerkliste (#772)', () => {
  const pendingConv = { _id: 'p1', meta: { reservations: [{ listing: { _id: 'G1' } }] } };
  beforeEach(() => resetPendingGuestyConversationsForTests());

  it('add/take/count: take leert, gleiche Id wird nicht doppelt vorgemerkt', () => {
    addPendingGuestyConversation(pendingConv);
    addPendingGuestyConversation({ ...pendingConv });
    expect(pendingGuestyConversationCount()).toBe(1);
    expect(takePendingGuestyConversations()).toHaveLength(1);
    expect(pendingGuestyConversationCount()).toBe(0);
  });

  it('Loop synct die vorgemerkte conv zuerst (deep, [conv]) und leert die Liste; regulärer Teil schließt sie aus', async () => {
    addPendingGuestyConversation(pendingConv);
    const d = deps();
    await runMessageLoopOnce(d);
    const calls = (d.syncGuesty as any).mock.calls;
    expect(calls[0]).toEqual([props[1], [pendingConv], { deep: true }]);
    expect(calls[1][2]).toMatchObject({ deep: false, excludeConvIds: new Set(['p1']) });
    expect(pendingGuestyConversationCount()).toBe(0);
  });

  it('Fehler (success=false oder Exception) → wieder vorgemerkt', async () => {
    addPendingGuestyConversation(pendingConv);
    await runMessageLoopOnce(deps({ syncGuesty: vi.fn().mockResolvedValue({ success: false, error: 'x' }) }));
    expect(pendingGuestyConversationCount()).toBe(1);
    resetMessageSyncLockForTests();
    await runMessageLoopOnce(deps({ syncGuesty: vi.fn().mockRejectedValue(new Error('boom')) }));
    expect(pendingGuestyConversationCount()).toBe(1);
  });

  it('Lock belegt → Lauf übersprungen, Liste bleibt stehen', async () => {
    addPendingGuestyConversation(pendingConv);
    messageSyncLock.tryAcquire('etl');
    await runMessageLoopOnce(deps());
    expect(pendingGuestyConversationCount()).toBe(1);
  });

  it('vorgemerkte conv ohne passendes Objekt wird verworfen (kein Endlos-Retry)', async () => {
    addPendingGuestyConversation({ _id: 'z', meta: { reservations: [{ listing: { _id: 'ZZ' } }] } });
    const d = deps();
    await runMessageLoopOnce(d);
    expect(pendingGuestyConversationCount()).toBe(0);
    expect((d.syncGuesty as any).mock.calls).toHaveLength(1); // nur der reguläre Teil
  });
});
