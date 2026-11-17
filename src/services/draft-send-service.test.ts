import { describe, it, expect, vi } from 'vitest';
import { sendClaimedDraft, type SendDraftDeps } from './draft-send-service.js';
import type { MessageThread } from '../types/messages.js';

const thread = { id: 'hostex:t1', source: 'hostex' } as MessageThread;
const deps = (over: Partial<SendDraftDeps> = {}): SendDraftDeps => ({
  sendReply: vi.fn().mockResolvedValue({ externalMessageId: 'x1' }),
  markDraftSent: vi.fn(), markDraftError: vi.fn(), upsertMessage: vi.fn(), ...over,
});

describe('sendClaimedDraft', () => {
  it('sendet, markiert sent_by und legt Outbound-Message an', async () => {
    const d = deps();
    expect(await sendClaimedDraft('d1', thread, 'Hallo', 'auto', d)).toEqual({ ok: true });
    expect(d.markDraftSent).toHaveBeenCalledWith('d1', 'x1', 'auto');
    expect((d.upsertMessage as any).mock.calls[0][0]).toMatchObject({ id: 'hostex:x1', direction: 'outbound', body: 'Hallo' });
  });
  it('Fehler → markDraftError, ok=false', async () => {
    const d = deps({ sendReply: vi.fn().mockRejectedValue(new Error('down')) });
    const r = await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d);
    expect(r.ok).toBe(false);
    expect(d.markDraftError).toHaveBeenCalledWith('d1', 'down');
  });
});

// #1210: nach erfolgreichem Versand schließt der Thread seinen Inquiry-Task selbst — nie blockierend.
describe('sendClaimedDraft — Inquiry-Task-Selbstschluss (#1210)', () => {
  it('ruft onSent mit der Thread-Id NACH dem Anlegen der Outbound-Zeile', async () => {
    const order: string[] = [];
    const d = deps({
      upsertMessage: vi.fn(() => { order.push('upsert'); }) as any,
      onSent: vi.fn(async () => { order.push('onSent'); }),
    });
    expect(await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d)).toEqual({ ok: true });
    expect(d.onSent).toHaveBeenCalledWith('hostex:t1');
    expect(order).toEqual(['upsert', 'onSent']);
  });
  it('SmartTasks-Fehler (async oder sync) bricht den Versand nicht ab', async () => {
    const async = deps({ onSent: vi.fn().mockRejectedValue(new Error('SmartTasks down')) });
    expect(await sendClaimedDraft('d1', thread, 'Hallo', 'micha', async)).toEqual({ ok: true });
    const sync = deps({ onSent: vi.fn(() => { throw new Error('kaputt'); }) });
    expect(await sendClaimedDraft('d1', thread, 'Hallo', 'micha', sync)).toEqual({ ok: true });
    expect(sync.markDraftError).not.toHaveBeenCalled();
  });
  it('fehlgeschlagener Versand ruft onSent nicht', async () => {
    const d = deps({ sendReply: vi.fn().mockRejectedValue(new Error('down')), onSent: vi.fn() });
    await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d);
    expect(d.onSent).not.toHaveBeenCalled();
  });
});
