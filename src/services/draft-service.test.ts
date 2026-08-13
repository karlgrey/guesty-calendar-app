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
  it('passes voice+facts into the system prompt and returns a text result', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hallo Darleen, gern!' });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'VOICE-X', facts: 'FACTS-Y' }, { call });
    expect(out).toEqual({ kind: 'text', body: 'Hallo Darleen, gern!' });
    const arg = call.mock.calls[0][0];
    expect(arg.systemPrompt).toContain('VOICE-X');
    expect(arg.systemPrompt).toContain('FACTS-Y');
    expect(arg.userMessage).toContain('Kann ich früher einchecken?');
    // The guest's name is passed so the model addresses them by name.
    expect(arg.userMessage).toContain('Darleen');
  });

  it('instructs a nameless greeting when the guest name is unknown', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hallo!' });
    const anon = { ...thread(), guest_name: null };
    await generateDraftForThread({ thread: anon, messages, voice: 'v', facts: 'f' }, { call });
    const arg = call.mock.calls[0][0];
    expect(arg.userMessage).toContain('nicht bekannt');
    expect(arg.userMessage).not.toContain('Darleen');
  });

  it('states the explicit no-reply criterion in the system prompt (#385)', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'x' });
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('WEDER eine Frage NOCH ein');
    expect(prompt).toContain('KEIN');
    expect(prompt).toContain('Im Zweifel antworten');
  });

  it('returns kind "no_reply" with reason when the model explicitly signals no_reply_needed (#385)', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: true, reason: 'reine Dankesnachricht ohne Frage' });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'no_reply', reason: 'reine Dankesnachricht ohne Frage' });
  });

  it('defaults the reason when no_reply_needed=true without a reason', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: true });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'no_reply', reason: '(kein Grund angegeben)' });
  });

  it('answers even when a thank-you message is followed by a question (#385, Bug 11.08.)', async () => {
    // Regression for the bug where "Vielen Dank für die Bestätigung." followed by explicit
    // questions produced an empty string under the old prompt rule. Under the new contract the
    // model must set no_reply_needed=false + reply whenever a question/anliegen is present —
    // this asserts the prompt instructs exactly that (actual LLM judgment isn't unit-testable).
    const call = vi.fn().mockResolvedValue({
      no_reply_needed: false,
      reply: 'Sehr gern, hier die Antworten auf deine Fragen …',
    });
    const thanksThenQuestions: Message[] = [
      { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-08-11T10:00Z', from_name: 'Darleen', from_address: null, to_address: null, subject: null, body: 'Vielen Dank für die Bestätigung. Können wir früher einchecken? Gibt es Parkplätze?', body_html: null, source: 'hostex', raw_meta: null },
    ];
    const out = await generateDraftForThread({ thread: thread(), messages: thanksThenQuestions, voice: 'v', facts: 'f' }, { call });
    expect(out.kind).toBe('text');
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('Beginnt eine Nachricht mit Dank');
    expect(prompt).toContain('antworte auf die Frage/das Anliegen');
  });

  it('returns kind "failed" on a malformed/unusable tool output (technical failure, #385)', async () => {
    const call = vi.fn().mockResolvedValue({ reply: '   ' }); // no_reply_needed missing, reply blank
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    expect(out.kind).toBe('failed');

    const call2 = vi.fn().mockResolvedValue({}); // nothing usable at all
    const out2 = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call: call2 });
    expect(out2.kind).toBe('failed');

    const call3 = vi.fn().mockResolvedValue(null);
    const out3 = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call: call3 });
    expect(out3.kind).toBe('failed');
  });

  it('returns kind "failed" when the call itself throws (e.g. API error after retries)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('claude down'));
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'failed', error: 'claude down' });
  });
});

describe('generateDraftForThread — Anrede nach Signatur der letzten Gastnachricht (#384)', () => {
  it('instructs to prefer the signature name over the booking name when they differ', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hey Lisa, klar doch!' });
    const signed: Message[] = [
      { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-08-12T10:00Z', from_name: 'Anna', from_address: null, to_address: null, subject: null, body: 'Können wir früher einchecken?\n\nViele Grüße,\nLisa', body_html: null, source: 'hostex', raw_meta: null },
    ];
    const bookedAsAnna = { ...thread(), guest_name: 'Anna' };
    const out = await generateDraftForThread({ thread: bookedAsAnna, messages: signed, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'text', body: 'Hey Lisa, klar doch!' });
    const prompt = call.mock.calls[0][0].userMessage;
    // Signatur der letzten Gastnachricht ist im Verlauf sichtbar …
    expect(prompt).toContain('Viele Grüße,\nLisa');
    // … und die Instruktion sagt explizit: Signatur schlägt Buchungsname.
    expect(prompt).toContain('DIESEM Vornamen an');
    expect(prompt).toContain('Das gilt auch, wenn die Signatur vom Buchungsnamen „Anna" abweicht.');
  });

  it('falls back to the booking name when the last guest message has no signature', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hey Anna, klar doch!' });
    const unsigned: Message[] = [
      { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-08-12T10:00Z', from_name: 'Anna', from_address: null, to_address: null, subject: null, body: 'Können wir früher einchecken?', body_html: null, source: 'hostex', raw_meta: null },
    ];
    const bookedAsAnna = { ...thread(), guest_name: 'Anna' };
    const out = await generateDraftForThread({ thread: bookedAsAnna, messages: unsigned, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'text', body: 'Hey Anna, klar doch!' });
    const prompt = call.mock.calls[0][0].userMessage;
    expect(prompt).toContain('Ist KEINE Signatur erkennbar, nutze stattdessen den Vornamen aus „Anna".');
  });

  it('instructs to use only the first name when the signature carries a full name', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hey Lisa, klar doch!' });
    const fullNameSigned: Message[] = [
      { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-08-12T10:00Z', from_name: 'Anna', from_address: null, to_address: null, subject: null, body: 'Können wir früher einchecken?\n\nLG, Lisa Müller', body_html: null, source: 'hostex', raw_meta: null },
    ];
    const bookedAsAnna = { ...thread(), guest_name: 'Anna' };
    const out = await generateDraftForThread({ thread: bookedAsAnna, messages: fullNameSigned, voice: 'v', facts: 'f' }, { call });
    expect(out).toEqual({ kind: 'text', body: 'Hey Lisa, klar doch!' });
    const prompt = call.mock.calls[0][0].userMessage;
    expect(prompt).toContain('LG, Lisa Müller');
    expect(prompt).toContain('bei vollem Namen (Vor- + Nachname) NUR den Vornamen verwenden (aus „Lisa Müller" wird „Lisa")');
  });

  it('still instructs the signature rule (with nameless fallback) when the booking name is unknown', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hey Lisa!' });
    const signedNoBooking: Message[] = [
      { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-08-12T10:00Z', from_name: null, from_address: null, to_address: null, subject: null, body: 'Frage zum Check-in.\n\nViele Grüße, Lisa', body_html: null, source: 'hostex', raw_meta: null },
    ];
    const anonBooking = { ...thread(), guest_name: null };
    await generateDraftForThread({ thread: anonBooking, messages: signedNoBooking, voice: 'v', facts: 'f' }, { call });
    const prompt = call.mock.calls[0][0].userMessage;
    expect(prompt).toContain('Der Buchungsname ist nicht bekannt — ist auch keine Signatur erkennbar,');
    expect(prompt).toContain('DIESEM Vornamen an');
  });
});

describe('generateDraftForThread — booking context (#364)', () => {
  it('includes the Buchungskontext block + the never-ask-again rule when bookingContext is set', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Klar, bis dann!' });
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
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Klar!' });
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null }, { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).not.toContain('BUCHUNGSKONTEXT');
    expect(prompt).not.toContain('NIEMALS erneut nach Zeitraum');
  });

  it('omits the Buchungskontext block when bookingContext is not passed at all', async () => {
    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Klar!' });
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).not.toContain('BUCHUNGSKONTEXT');
  });
});
