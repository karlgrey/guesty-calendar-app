import { describe, it, expect, beforeEach } from 'vitest';
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

  it('nutzt Payload-Konversation, synct nur das passende Objekt, dann Kette für genau diesen Thread', async () => {
    const d = deps();
    await handleGuestyInbound({ event: 'x', conversation: conv, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).not.toHaveBeenCalled();
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [conv]);
    expect(d.generateDrafts).toHaveBeenCalledWith(props[1], ['guesty:c1']);
  });
  it('holt die Konversation nach, wenn das Payload keine Listing-Info hat', async () => {
    const d = deps();
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).toHaveBeenCalledWith('c1');
    expect(d.syncGuesty).toHaveBeenCalledTimes(1);
  });
  it('kein Objekt passt → nichts, kein Fehler', async () => {
    const d = deps({ getConversation: vi.fn().mockResolvedValue({ _id: 'c1', meta: { reservations: [{ listing: { _id: 'ZZ' } }] } }) });
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.syncGuesty).not.toHaveBeenCalled();
  });
});
