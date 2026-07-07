import { describe, it, expect } from 'vitest';
import { resolveOutboundModuleType } from './guesty-channel.js';
import type { Message } from '../types/messages.js';

function msg(direction: Message['direction'], rawMeta: object | null, sentAt: string): Message {
  return {
    id: `m-${sentAt}`, thread_id: 't', direction, sent_at: sentAt,
    from_name: null, from_address: null, to_address: null, subject: null,
    body: 'x', body_html: null, source: 'guesty',
    raw_meta: rawMeta ? JSON.stringify(rawMeta) : null,
  };
}

describe('resolveOutboundModuleType', () => {
  it('mirrors the module type of the last inbound message', () => {
    const messages = [
      msg('inbound', { type: 'platform' }, '2026-01-01'),
      msg('outbound', { type: 'airbnb2' }, '2026-01-02'),
      msg('inbound', { type: 'airbnb2' }, '2026-01-03'),
    ];
    expect(resolveOutboundModuleType(messages)).toBe('airbnb2');
  });

  it('returns null when the last inbound has type log', () => {
    expect(resolveOutboundModuleType([msg('inbound', { type: 'log' }, '2026-01-01')])).toBeNull();
  });

  it('returns null when the last inbound has no type / broken raw_meta', () => {
    expect(resolveOutboundModuleType([msg('inbound', {}, '2026-01-01')])).toBeNull();
    const broken = msg('inbound', null, '2026-01-02');
    broken.raw_meta = '{not json';
    expect(resolveOutboundModuleType([broken])).toBeNull();
  });

  it('returns null when there is no inbound message at all', () => {
    expect(resolveOutboundModuleType([msg('outbound', { type: 'airbnb2' }, '2026-01-01')])).toBeNull();
    expect(resolveOutboundModuleType([])).toBeNull();
  });
});
