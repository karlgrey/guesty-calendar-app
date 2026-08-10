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
    // The guest's name is passed so the model addresses them by name.
    expect(arg.userMessage).toContain('Darleen');
  });

  it('instructs a nameless greeting when the guest name is unknown', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Hallo!' });
    const anon = { ...thread(), guest_name: null };
    await generateDraftForThread({ thread: anon, messages, voice: 'v', facts: 'f' }, { call });
    const arg = call.mock.calls[0][0];
    expect(arg.userMessage).toContain('nicht bekannt');
    expect(arg.userMessage).not.toContain('Darleen');
  });

  it('returns null on an empty/malformed reply', async () => {
    const call = vi.fn().mockResolvedValue({ reply: '   ' });
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call })).toBeNull();
    const call2 = vi.fn().mockResolvedValue({});
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call: call2 })).toBeNull();
  });
});

describe('generateDraftForThread — booking context (#364)', () => {
  it('includes the Buchungskontext block + the never-ask-again rule when bookingContext is set', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Klar, bis dann!' });
    await generateDraftForThread(
      { thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: 'Bestätigte Buchung: Zeitraum 02.08.2026–07.08.2026, 5 Nächte, 2 Personen.' },
      { call }
    );
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('--- BUCHUNGSKONTEXT (liegt der Plattform bereits vor) ---');
    expect(prompt).toContain('Bestätigte Buchung: Zeitraum 02.08.2026–07.08.2026, 5 Nächte, 2 Personen.');
    expect(prompt).toContain('--- ENDE BUCHUNGSKONTEXT ---');
    expect(prompt).toContain('frage den Gast NIEMALS erneut nach Zeitraum, Nächten oder Personenzahl');
  });

  it('omits the Buchungskontext block entirely when bookingContext is null', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Klar!' });
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null }, { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).not.toContain('BUCHUNGSKONTEXT');
    expect(prompt).not.toContain('NIEMALS erneut nach Zeitraum');
  });

  it('omits the Buchungskontext block when bookingContext is not passed at all', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Klar!' });
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).not.toContain('BUCHUNGSKONTEXT');
  });
});
