import { describe, it, expect, vi } from 'vitest';
import { generateDraftForThread } from './draft-service.js';
import type { MessageThread, Message } from '../types/messages.js';

function thread(): MessageThread {
  return {
    id: 'hostex:c1', listing_id: 'L', source: 'hostex', channel: 'airbnb', guest_name: 'Darleen',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}
const messages: Message[] = [
  { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-06-30T10:00Z', from_name: 'Darleen', from_address: null, to_address: null, subject: null, body: 'Kann ich früher einchecken?', body_html: null, source: 'hostex', raw_meta: null },
];

describe('generateDraftForThread', () => {
  it('passes voice+facts into the system prompt and returns the reply', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Hallo Darleen, gern!' });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'VOICE-X', facts: 'FACTS-Y' }, { call });
    expect(out).toBe('Hallo Darleen, gern!');
    const arg = call.mock.calls[0][0];
    expect(arg.systemPrompt).toContain('VOICE-X');
    expect(arg.systemPrompt).toContain('FACTS-Y');
    expect(arg.userMessage).toContain('Kann ich früher einchecken?');
  });

  it('returns null on an empty/malformed reply', async () => {
    const call = vi.fn().mockResolvedValue({ reply: '   ' });
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call })).toBeNull();
    const call2 = vi.fn().mockResolvedValue({});
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call: call2 })).toBeNull();
  });
});
