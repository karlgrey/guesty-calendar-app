import { describe, it, expect } from 'vitest';
import { mapGuestyPost } from './sync-guesty-messages.js';

const NOW = '2026-11-24T10:00:00Z';
const patterns = [/Testvorlage Willkommen/i];
const post = (sentBy: string, body: string) => ({
  _id: 'p1', sentBy, body, createdAt: '2026-11-23T09:00:00Z',
  module: { type: 'airbnb2', externalId: 'ext-1' }, isFromMigration: false,
});
const meta = (m: { raw_meta?: string | null }) => JSON.parse(m.raw_meta!);

describe('mapGuestyPost (#1298)', () => {
  it('host + Muster → system, automatic, type/externalId bleiben', () => {
    const m = mapGuestyPost(post('host', 'Testvorlage Willkommen bei uns'), 'guesty:t1', 'Anna', NOW, patterns);
    expect(m.direction).toBe('system');
    expect(m.from_name).toBe('host');
    expect(m.id).toBe('guesty:p1');
    expect(meta(m)).toMatchObject({ type: 'airbnb2', externalId: 'ext-1', automatic: true });
  });
  it('host ohne Muster → outbound, kein automatic', () => {
    const m = mapGuestyPost(post('host', 'Normale Antwort'), 'guesty:t1', 'Anna', NOW, patterns);
    expect(m.direction).toBe('outbound');
    expect(meta(m)).not.toHaveProperty('automatic');
  });
  it('guest mit Mustertext → inbound', () => {
    const m = mapGuestyPost(post('guest', 'Testvorlage Willkommen'), 'guesty:t1', 'Anna', NOW, patterns);
    expect(m.direction).toBe('inbound');
    expect(m.from_name).toBe('Anna');
    expect(meta(m)).not.toHaveProperty('automatic');
  });
  it('log-post → system ohne automatic', () => {
    const m = mapGuestyPost(post('log', 'Testvorlage Willkommen'), 'guesty:t1', 'Anna', NOW, patterns);
    expect(m.direction).toBe('system');
    expect(meta(m)).not.toHaveProperty('automatic');
  });
  it('Default-Liste: Check-in-Platzhaltertext → system', () => {
    const body = 'Hallo Anna, dein Aufenthalt findet bald statt. Du kannst am 20. Nov. 2026 ab 15:00 jederzeit einchecken.\n\nHier ist die Adresse: Musterstraße 1.';
    const m = mapGuestyPost(post('host', body), 'guesty:t1', 'Anna', NOW);
    expect(m.direction).toBe('system');
    expect(meta(m).automatic).toBe(true);
  });
});
