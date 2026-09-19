import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { handleGuestyInbound, type InboundDeps } from './handle-guesty-inbound.js';
import { messageSyncLock } from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';

const props = [{ slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1' }, { slug: 'u19', provider: 'guesty', guestyPropertyId: 'G2' }] as PropertyConfig[];
const conv = { _id: 'c1', meta: { reservations: [{ listing: { _id: 'G2' } }] } };
function deps(over: Partial<InboundDeps> = {}): InboundDeps {
  return { getProperties: () => props, getConversation: vi.fn().mockResolvedValue(conv), syncGuesty: vi.fn().mockResolvedValue(undefined), generateDrafts: vi.fn().mockResolvedValue(undefined), ...over };
}

describe('handleGuestyInbound', () => {
  beforeEach(() => messageSyncLock.release());

  // Fix-Runde 1 (Important #1): das Payload wird NIE direkt persistiert (Spec 3.1) — die
  // Konversation kommt immer per getConversation, selbst wenn das Payload schon Listing-Info
  // trägt. Sonst würde ein unvollständiges Payload z.B. guest_name in der DB löschen.
  it('lädt die Konversation immer per API nach — auch wenn das Payload selbst schon Listing-Info trägt —, synct nur das passende Objekt, dann Kette für genau diesen Thread', async () => {
    const d = deps();
    // Payload trägt (untypisch, aber laut Guesty-Doku möglich) bereits eigene Listing-Info —
    // die muss ignoriert werden: sonst würde ein unvollständiges Payload z.B. guest_name löschen.
    await handleGuestyInbound({ event: 'x', conversation: conv, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).toHaveBeenCalledWith('c1');
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [conv]);
    expect(d.generateDrafts).toHaveBeenCalledWith(props[1], ['guesty:c1']);
  });
  it('kein Objekt passt → nichts, kein Fehler', async () => {
    const d = deps({ getConversation: vi.fn().mockResolvedValue({ _id: 'c1', meta: { reservations: [{ listing: { _id: 'ZZ' } }] } }) });
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.syncGuesty).not.toHaveBeenCalled();
  });

  describe('Lock', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('Lock vorbelegt (ETL) → syncGuesty wird nicht aufgerufen, kein Fehler', async () => {
      messageSyncLock.tryAcquire('etl');
      const d = deps();
      const resultPromise = handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(resultPromise).resolves.toBeUndefined();
      expect(d.syncGuesty).not.toHaveBeenCalled();
      expect(messageSyncLock.holder).toBe('etl');
    });

    it('syncGuesty wirft → Lock wird trotzdem freigegeben', async () => {
      const d = deps({ syncGuesty: vi.fn().mockRejectedValue(new Error('boom')) });
      await expect(handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d)).rejects.toThrow('boom');
      expect(messageSyncLock.holder).toBeNull();
    });
  });
});
