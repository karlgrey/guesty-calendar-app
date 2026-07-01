import { describe, it, expect, vi } from 'vitest';
import { sendReply } from './message-sender.js';
import type { MessageThread } from '../types/messages.js';

function thread(source: MessageThread['source'], id: string): MessageThread {
  return {
    id, listing_id: 'L', source, channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}

describe('sendReply', () => {
  it('sends a hostex reply with the conversation id stripped of prefix', async () => {
    const hostexSend = vi.fn().mockResolvedValue({ message_id: 'ext-7' });
    const res = await sendReply(thread('hostex', 'hostex:c-42'), 'Hallo', { hostexSend });
    expect(hostexSend).toHaveBeenCalledWith('c-42', 'Hallo');
    expect(res.externalMessageId).toBe('ext-7');
  });

  it('throws for guesty in Schnitt 1', async () => {
    await expect(sendReply(thread('guesty', 'guesty:x'), 'Hi')).rejects.toThrow(/not implemented/i);
  });
});
