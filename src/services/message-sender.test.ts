import { describe, it, expect, vi } from 'vitest';
import { sendReply } from './message-sender.js';
import type { Message, MessageThread } from '../types/messages.js';

function thread(source: MessageThread['source'], id: string): MessageThread {
  return {
    id, listing_id: 'L', source, channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}

function inboundMsg(moduleType: string | null): Message {
  return {
    id: 'm1', thread_id: 'guesty:x', direction: 'inbound', sent_at: '2026-01-01',
    from_name: null, from_address: null, to_address: null, subject: null,
    body: 'q', body_html: null, source: 'guesty',
    raw_meta: moduleType ? JSON.stringify({ type: moduleType }) : null,
  };
}

describe('sendReply', () => {
  it('sends a hostex reply with the conversation id stripped of prefix', async () => {
    const hostexSend = vi.fn().mockResolvedValue({ message_id: 'ext-7' });
    const deps = { hostexSend, guestySend: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
    const res = await sendReply(thread('hostex', 'hostex:c-42'), 'Hallo', deps);
    expect(hostexSend).toHaveBeenCalledWith('c-42', 'Hallo');
    expect(res.externalMessageId).toBe('ext-7');
  });

  it('sends a guesty reply mirroring the last inbound module type', async () => {
    const guestySend = vi.fn().mockResolvedValue({ messageId: 'post-9' });
    const deps = { hostexSend: vi.fn(), guestySend, getMessages: vi.fn().mockReturnValue([inboundMsg('airbnb2')]) };
    const res = await sendReply(thread('guesty', 'guesty:c-1'), 'Hallo', deps);
    expect(guestySend).toHaveBeenCalledWith('c-1', 'Hallo', 'airbnb2');
    expect(res.externalMessageId).toBe('post-9');
  });

  it('refuses a guesty send when the channel cannot be resolved', async () => {
    const deps = { hostexSend: vi.fn(), guestySend: vi.fn(), getMessages: vi.fn().mockReturnValue([inboundMsg(null)]) };
    await expect(sendReply(thread('guesty', 'guesty:c-1'), 'Hi', deps)).rejects.toThrow(/Kanal nicht auflösbar/);
    expect(deps.guestySend).not.toHaveBeenCalled();
  });

  it('still throws for unknown providers', async () => {
    await expect(sendReply(thread('gmail', 'gmail:x'), 'Hi')).rejects.toThrow(/not implemented/i);
  });
});
