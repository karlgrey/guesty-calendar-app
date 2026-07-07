import { describe, it, expect } from 'vitest';
import { shouldDeepFetchConversation, INCREMENTAL_ACTIVE_WINDOW_DAYS, STAY_GRACE_DAYS } from './sync-guesty-messages.js';

const NOW = new Date('2026-07-07T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000).toISOString();
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 24 * 3600 * 1000).toISOString();

function conv(checkOut?: string): any {
  return { meta: { reservations: checkOut ? [{ checkOut }] : [] } };
}

describe('shouldDeepFetchConversation', () => {
  it('always fetches unknown conversations', () => {
    expect(shouldDeepFetchConversation(conv(), null, NOW)).toBe(true);
  });

  it('fetches known conversations with recent local activity', () => {
    const active = { last_message_at: daysAgo(3) };
    expect(shouldDeepFetchConversation(conv(daysAgo(300)), active, NOW)).toBe(true);
  });

  it('fetches stale conversations whose stay is upcoming or recently over', () => {
    const stale = { last_message_at: daysAgo(200) };
    expect(shouldDeepFetchConversation(conv(daysAhead(60)), stale, NOW)).toBe(true); // künftiger Aufenthalt
    expect(shouldDeepFetchConversation(conv(daysAgo(STAY_GRACE_DAYS - 1)), stale, NOW)).toBe(true); // gerade ausgecheckt
  });

  it('skips stale conversations whose stay is long over', () => {
    const stale = { last_message_at: daysAgo(INCREMENTAL_ACTIVE_WINDOW_DAYS + 1) };
    expect(shouldDeepFetchConversation(conv(daysAgo(STAY_GRACE_DAYS + 1)), stale, NOW)).toBe(false);
    expect(shouldDeepFetchConversation(conv(), stale, NOW)).toBe(false); // keine Reservierungsdaten
  });
});
