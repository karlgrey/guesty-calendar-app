import { describe, it, expect, vi } from 'vitest';
import { sendClaimedDraft, type SendDraftDeps } from './draft-send-service.js';
import type { MessageThread } from '../types/messages.js';

const thread = { id: 'hostex:t1', source: 'hostex' } as MessageThread;
const mk = (ext: string, now: () => Date) => {
  const upsertMessage = vi.fn();
  const d: SendDraftDeps = {
    sendReply: vi.fn().mockResolvedValue({ externalMessageId: ext }),
    markDraftSent: vi.fn(), markDraftError: vi.fn(), upsertMessage, now,
  };
  return { d, upsertMessage };
};

describe('sendClaimedDraft sent_at (#974)', () => {
  it('Sommerzeit: +02:00 → UTC', async () => {
    const { d, upsertMessage } = mk('x1', () => new Date('2026-10-23T08:55:48.285+02:00'));
    await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d);
    expect(upsertMessage.mock.calls[0][0].sent_at).toBe('2026-10-23T06:55:48.285Z');
  });
  it('Winterzeit: +01:00 → UTC', async () => {
    const { d, upsertMessage } = mk('x1', () => new Date('2026-10-26T10:44:24.155+01:00'));
    await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d);
    expect(upsertMessage.mock.calls[0][0].sent_at).toBe('2026-10-26T09:44:24.155Z');
  });
  it('leere externalMessageId → id sent:<draftId>', async () => {
    const { d, upsertMessage } = mk('', () => new Date('2026-10-26T10:44:24.155+01:00'));
    await sendClaimedDraft('d9', thread, 'Hallo', 'micha', d);
    expect(upsertMessage.mock.calls[0][0].id).toBe('sent:d9');
  });
});
