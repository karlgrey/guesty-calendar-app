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
  type MessageLoopDeps,
} from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';

const props = [
  { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'H1', vaultNote: 'b.md' },
  { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1', vaultNote: 'f.md' },
  { slug: 'florenz', provider: 'airbnb-mail' },
] as unknown as PropertyConfig[];

function deps(over: Partial<MessageLoopDeps> = {}): MessageLoopDeps {
  return {
    getProperties: () => props,
    syncHostex: vi.fn().mockResolvedValue({ success: true }),
    fetchGuestyConversations: vi.fn().mockResolvedValue([{ _id: 'c1' }]),
    syncGuesty: vi.fn().mockResolvedValue({ success: true }),
    generateDrafts: vi.fn().mockResolvedValue({ generated: 0, skipped: 0 }),
    ...over,
  };
}
beforeEach(() => resetMessageSyncLockForTests());

describe('runMessageLoopOnce', () => {
  it('synct Hostex- und Guesty-Objekte, Guesty-Liste nur einmal, dann Entwürfe', async () => {
    const d = deps();
    const r = await runMessageLoopOnce(d);
    expect(r).toEqual({ skipped: false, properties: 2 });
    expect(d.syncHostex).toHaveBeenCalledTimes(1);
    expect(d.syncHostex).toHaveBeenCalledWith(props[0], expect.any(Map));
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
