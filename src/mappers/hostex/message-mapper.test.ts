// src/mappers/hostex/message-mapper.test.ts
import { describe, it, expect } from 'vitest';
import { mapHostexDirection, mapHostexChannel, mapHostexConversation } from './message-mapper.js';
import type { HostexConversationDetail } from '../../services/hostex-client.js';

describe('hostex message mapper', () => {
  it('maps sender role to direction', () => {
    expect(mapHostexDirection('guest')).toBe('inbound');
    expect(mapHostexDirection('host')).toBe('outbound');
    expect(mapHostexDirection('automation')).toBe('system');
  });

  it('maps channel_type to internal channel', () => {
    expect(mapHostexChannel('airbnb')).toBe('airbnb');
    expect(mapHostexChannel('booking.com')).toBe('booking.com');
    expect(mapHostexChannel('manual')).toBe('manual');
    expect(mapHostexChannel('whatever')).toBe('other');
  });

  it('maps a conversation to thread + messages with stable ids, filtering non-Text', () => {
    const detail: HostexConversationDetail = {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
        { id: 'm-2', sender_role: 'host', display_type: 'Text', content: 'Hi', created_at: '2026-06-30T11:00:00Z' },
        { id: 'm-3', sender_role: 'guest', display_type: 'ReservationAlteration', content: '', created_at: '2026-06-30T12:00:00Z' },
      ],
    };
    const { thread, messages } = mapHostexConversation(detail, 'listing-9', '2026-07-01T00:00:00Z');

    expect(thread.id).toBe('hostex:c-1');
    expect(thread.listing_id).toBe('listing-9');
    expect(thread.source).toBe('hostex');
    expect(thread.channel).toBe('airbnb');
    expect(thread.guest_name).toBe('Darleen');
    expect(thread.message_count).toBe(2); // only Text messages counted
    expect(thread.first_message_at).toBe('2026-06-30T10:00:00Z');
    expect(thread.last_message_at).toBe('2026-06-30T11:00:00Z');

    // the ReservationAlteration system card (m-3) is filtered out
    expect(messages.map((m) => m.id)).toEqual(['hostex:m-1', 'hostex:m-2']);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].thread_id).toBe('hostex:c-1');
    expect(messages[0].body).toBe('Hallo');
    expect(messages[0].source).toBe('hostex');
  });
});
