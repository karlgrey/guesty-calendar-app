// #1082 Stufe 1 — Akzeptanz: Fixture-Test zeigt die Few-shot-Beispiele („So schreibt Micha“) im
// Entwurfs-Prompt. Teil 1 mit gemocktem Finder (Prompt-Aufbau, Query, Fehlertoleranz), Teil 2 als
// Ende-zu-Ende-Fixture über eine In-Memory-DB mit gesendeten Drafts (echtes Repository + Auswahl).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { generateDraftForThread, buildSystemPrompt } from './draft-service.js';
import { findHostExamples, type HostExample } from './host-examples.js';
import { listHostExampleCandidates } from '../repositories/host-example-repository.js';
import type { MessageThread, Message } from '../types/messages.js';

function thread(p: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 'guesty:cur', listing_id: 'FARM', source: 'guesty', channel: 'airbnb', guest_name: 'Darleen',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: 'confirmed', conversion_category: 'CONFIRMED', classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '', ...p,
  };
}
const messages: Message[] = [
  { id: 'm1', thread_id: 'guesty:cur', direction: 'inbound', sent_at: '2026-11-09T10:00:00Z', from_name: 'Darleen', from_address: null, to_address: null, subject: null, body: 'Können wir schon früher anreisen?', body_html: null, source: 'guesty', raw_meta: null },
];
const EX: HostExample[] = [
  { body: 'Hallo Anna, klar, ab 13 Uhr geht das. Liebe Grüße Micha', guestMessage: 'Dürfen wir früher kommen?', sameObject: true, situationMatch: true },
  { body: 'Hallo Max, gern. Liebe Grüße Micha', guestMessage: null, sameObject: false, situationMatch: false },
];
const reply = () => vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hallo Darleen, gern. Liebe Grüße Micha' });

describe('generateDraftForThread mit Host-Beispielen (#1082)', () => {
  it('setzt die Beispiele als „So schreibt Micha“ zwischen VOICE und OBJEKTWISSEN', async () => {
    const call = reply();
    const findExamples = vi.fn().mockReturnValue(EX);
    await generateDraftForThread({ thread: thread(), messages, voice: 'VOICE-X', facts: 'FACTS-Y', bookingContext: null }, { call, findExamples });
    const prompt: string = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('SO SCHREIBT MICHA');
    expect(prompt).toContain('Hallo Anna, klar, ab 13 Uhr geht das. Liebe Grüße Micha');
    expect(prompt).toContain('Hallo Max, gern. Liebe Grüße Micha');
    expect(prompt).toContain('KEIN Faktenübertrag');
    const iVoiceEnd = prompt.indexOf('--- ENDE VOICE ---');
    const iBlock = prompt.indexOf('SO SCHREIBT MICHA');
    const iFacts = prompt.indexOf('--- OBJEKTWISSEN ---');
    expect(iVoiceEnd).toBeLessThan(iBlock);
    expect(iBlock).toBeLessThan(iFacts);
  });

  it('fragt mit Objekt, Quelle, Sprache, letzter Gastnachricht und Situation ab', async () => {
    const findExamples = vi.fn().mockReturnValue([]);
    await generateDraftForThread(
      { thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null, guestLanguage: 'de', isBookingRequest: true },
      { call: reply(), findExamples },
    );
    expect(findExamples).toHaveBeenCalledWith({
      threadId: 'guesty:cur', listingId: 'FARM', source: 'guesty', guestLanguage: 'de',
      lastGuestMessage: 'Können wir schon früher anreisen?', judgeCategoryHint: 'buchungsanfrage', conversionCategory: 'CONFIRMED',
    });
  });

  it('ohne Buchungsanfrage keine Judge-Kategorie als Hinweis', async () => {
    const findExamples = vi.fn().mockReturnValue([]);
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null }, { call: reply(), findExamples });
    expect(findExamples.mock.calls[0][0].judgeCategoryHint).toBeNull();
  });

  it('Finder-Fehler ist nicht fatal — Entwurf ohne Beispiel-Block', async () => {
    const call = reply();
    const findExamples = vi.fn(() => { throw new Error('DB weg'); });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null }, { call, findExamples });
    expect(out.kind).toBe('text');
    expect(call.mock.calls[0][0].systemPrompt).not.toContain('SO SCHREIBT MICHA');
  });

  it('ohne Finder (z. B. Live-Fixture-Lauf) und ohne Beispiele kein Block', async () => {
    const call = reply();
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null }, { call });
    expect(call.mock.calls[0][0].systemPrompt).not.toContain('SO SCHREIBT MICHA');
  });

  it('explizit übergebene hostExamples haben Vorrang vor dem Finder', async () => {
    const call = reply();
    const findExamples = vi.fn().mockReturnValue([]);
    await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null, hostExamples: EX }, { call, findExamples });
    expect(findExamples).not.toHaveBeenCalled();
    expect(call.mock.calls[0][0].systemPrompt).toContain('Hallo Anna, klar');
  });

  it('buildSystemPrompt bleibt ohne Beispiele unverändert (rückwärtskompatibel)', () => {
    const a = buildSystemPrompt('v', 'f', null, thread(), 'de', false, false, new Date('2026-11-09T10:00:00Z'));
    const b = buildSystemPrompt('v', 'f', null, thread(), 'de', false, false, new Date('2026-11-09T10:00:00Z'), null, null, []);
    expect(b).toBe(a);
    expect(a).not.toContain('SO SCHREIBT MICHA');
  });
});

describe('Ende-zu-Ende-Fixture: gesendete Drafts aus der DB landen im Prompt (#1082)', () => {
  let db: Database.Database;
  const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

  function seedThread(id: string, listing: string, conv: string | null = null) {
    db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at, conversion_category)
      VALUES (?, ?, 'guesty', 'airbnb', 'Gast', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', 1, '2026-11-01T10:00:00Z', ?)`).run(id, listing, conv);
  }
  function seedCase(id: string, listing: string, guest: string, body: string, o: { sentBy?: string; status?: string; changed?: number; original?: string; sentAt?: string } = {}) {
    seedThread(`guesty:${id}`, listing, 'CONFIRMED');
    db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, 'inbound', '2026-11-01T09:00:00Z', ?, 'guesty')`).run(`${id}:m`, `guesty:${id}`, guest);
    db.prepare(`INSERT INTO message_drafts (id, thread_id, provider, body, generated_by) VALUES (?, ?, 'guesty', ?, 'llm')`).run(id, `guesty:${id}`, body);
    db.prepare(`UPDATE message_drafts SET status = ?, sent_by = ?, sent_body_changed = ?, original_body = ?, created_at = '2026-11-01 09:30:00', sent_at = ? WHERE id = ?`)
      .run(o.status ?? 'sent', o.sentBy ?? 'micha', o.changed ?? 0, o.original ?? null, o.sentAt ?? '2026-11-01T10:00:00Z', id);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    for (const f of [
      '014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql', '019_add_draft_model.sql',
      '020_add_feedback_and_suggestions.sql', '025_add_thread_discarded_at.sql', '027_add_auto_send.sql', '029_add_smarttasks_task.sql',
      '030_add_booking_request.sql', '031_add_judge_reasoning_and_release.sql', '032_add_draft_regeneration.sql', '039_add_draft_original_body.sql',
    ]) db.exec(mig(f));
    setDatabase(db);
    seedThread('guesty:cur', 'FARM', 'CONFIRMED');
  });
  afterEach(() => { resetDatabase(); db.close(); });

  it('zeigt Michas gesendete Texte (unchanged + changed), nie Entwurf, Auto-Send oder Verworfenes', async () => {
    seedCase('a', 'FARM', 'Dürfen wir früher anreisen?', 'Hallo Lisa, klar, kommt gern ab 13 Uhr. Liebe Grüße Micha');
    seedCase('b', 'FARM', 'Gibt es Bettwäsche?', 'Hallo Tom, ja, ist alles da. Liebe Grüße Micha', {
      changed: 1, original: 'Hallo Tom, ehrlich gesagt ist Bettwäsche selbstverständlich vorhanden — wo auch immer ihr herkommt!',
    });
    seedCase('c', 'FARM', 'Wo parken wir?', 'Hallo Jana, ihr parkt direkt am Hof neben der Scheune. Liebe Grüße Micha', { sentBy: 'auto' });
    seedCase('d', 'FARM', 'Wann ist Check-out?', 'Hallo Paul, Check-out ist bis 11 Uhr. Liebe Grüße Micha', { status: 'discarded', sentAt: undefined });
    seedCase('e', 'OTHER', 'Können wir früher kommen?', 'Hallo Eva, gern, das klappt bei uns. Liebe Grüße Micha');

    const call = vi.fn().mockResolvedValue({ no_reply_needed: false, reply: 'Hallo Darleen, gern. Liebe Grüße Micha' });
    await generateDraftForThread(
      { thread: thread(), messages, voice: 'v', facts: 'f', bookingContext: null, guestLanguage: 'de' },
      { call, findExamples: (q) => findHostExamples(q, { list: listHostExampleCandidates, now: () => new Date('2026-11-09T12:00:00Z') }) },
    );
    const prompt: string = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toContain('SO SCHREIBT MICHA');
    expect(prompt).toContain('Hallo Lisa, klar, kommt gern ab 13 Uhr. Liebe Grüße Micha');
    expect(prompt).toContain('Hallo Tom, ja, ist alles da. Liebe Grüße Micha');
    expect(prompt).not.toContain('ehrlich gesagt');
    expect(prompt).not.toContain('direkt am Hof neben der Scheune');
    expect(prompt).not.toContain('Check-out ist bis 11 Uhr');
    // Zwei Treffer im eigenen Objekt → Fallback objektübergreifend füllt auf drei auf.
    expect(prompt).toContain('(anderes Objekt)');
    expect(prompt).toContain('Hallo Eva, gern, das klappt bei uns.');
    // Ähnlichste Gastnachricht (früher anreisen) steht vorn.
    expect(prompt.indexOf('Hallo Lisa')).toBeLessThan(prompt.indexOf('Hallo Tom'));
  });
});
