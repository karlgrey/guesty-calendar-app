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
