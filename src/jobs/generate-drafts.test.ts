import { describe, it, expect, vi } from 'vitest';
import { generateDraftsForProperty, resolveDraftSource, DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER, type DraftGenDeps } from './generate-drafts.js';
import type { PropertyConfig } from '../config/properties.js';
import type { MessageThread, NewDraft } from '../types/messages.js';

function mkThread(id: string): MessageThread {
  return {
    id, listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null, inquiry_id: null,
    reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}
const property = { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'L1', vaultNote: 'Bootshaus.md' } as unknown as PropertyConfig;

function deps(over: Partial<DraftGenDeps> = {}): DraftGenDeps {
  return {
    getThreads: vi.fn().mockReturnValue([mkThread('hostex:a'), mkThread('hostex:b')]),
    getMessages: vi.fn().mockReturnValue([]),
    loadVoice: vi.fn().mockReturnValue('VOICE'),
    loadFacts: vi.fn().mockReturnValue('FACTS'),
    generate: vi.fn().mockResolvedValue({ kind: 'text', body: 'REPLY' }),
    create: vi.fn(),
    markNoReply: vi.fn(),
    buildBookingContext: vi.fn().mockReturnValue(null),
    gate: vi.fn().mockResolvedValue({}),
    updateDraftBody: vi.fn(),
    ...over,
  };
}

describe('generateDraftsForProperty', () => {
  it('creates one draft per needing-reply thread and reports counts', async () => {
    const d = deps();
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 2, skipped: 0 });
    expect(d.create).toHaveBeenCalledTimes(2);
    expect((d.getThreads as any)).toHaveBeenCalledWith('hostex', 'L1', DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER);
  });

  it('generates drafts for a guesty property with provider=guesty', async () => {
    const created: NewDraft[] = [];
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('guesty:t1')]),
      create: (draft) => { created.push(draft); },
      generate: vi.fn().mockResolvedValue({ kind: 'text', body: 'REPLY' }),
    });
    const guestyProperty = {
      slug: 'farmhouse', name: 'Farmhouse', provider: 'guesty',
      guestyPropertyId: 'GL9', vaultNote: 'Gästekommunikation Farmhouse Prasser.md',
    } as unknown as PropertyConfig;
    const res = await generateDraftsForProperty(guestyProperty, d);
    expect(res).toEqual({ generated: 1, skipped: 0 });
    expect((d.getThreads as any)).toHaveBeenCalledWith('guesty', 'GL9', DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER);
    expect(created[0].provider).toBe('guesty');
  });

  it('skips a thread when generate reports kind "no_reply" and remembers the no-reply decision (#385)', async () => {
    const d = deps({
      generate: vi.fn()
        .mockResolvedValueOnce({ kind: 'text', body: 'REPLY' })
        .mockResolvedValueOnce({ kind: 'no_reply', reason: 'reine Dankesnachricht' }),
    });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 1, skipped: 1 });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.markNoReply).toHaveBeenCalledTimes(1);
    expect(d.markNoReply).toHaveBeenCalledWith('hostex:b');
  });

  it('skips a thread on kind "failed" WITHOUT marking no-reply, so the next run retries it (#385)', async () => {
    const d = deps({
      generate: vi.fn()
        .mockResolvedValueOnce({ kind: 'text', body: 'REPLY' })
        .mockResolvedValueOnce({ kind: 'failed', error: 'Tool-Output ohne verwertbaren reply-Text' }),
    });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 1, skipped: 1 });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.markNoReply).not.toHaveBeenCalled();
  });

  it('is a no-op when voice or facts are missing', async () => {
    const d = deps({ loadFacts: vi.fn().mockReturnValue(null) });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 0, skipped: 0 });
    expect(d.getThreads).not.toHaveBeenCalled();
  });

  it('is a no-op when the property has no vaultNote or no draft source', async () => {
    const d = deps();
    const noVault = { slug: 'x', provider: 'hostex', hostexPropertyId: 'L1' } as unknown as PropertyConfig;
    expect(await generateDraftsForProperty(noVault, d)).toEqual({ generated: 0, skipped: 0 });
    const airbnbMail = { slug: 'y', provider: 'airbnb-mail', vaultNote: 'z.md' } as unknown as PropertyConfig;
    expect(await generateDraftsForProperty(airbnbMail, d)).toEqual({ generated: 0, skipped: 0 });
    expect(d.loadVoice).not.toHaveBeenCalled();
  });

  it('does not throw if generate rejects (counts as skipped)', async () => {
    const d = deps({ generate: vi.fn().mockRejectedValue(new Error('claude down')) });
    const res = await generateDraftsForProperty(property, d);
    expect(res.generated).toBe(0);
    expect(res.skipped).toBe(2);
  });

  it('builds and passes bookingContext through to generate for each thread (#364)', async () => {
    const threadA = mkThread('hostex:a');
    const threadB = mkThread('hostex:b');
    const buildBookingContext = vi.fn((t: MessageThread) => (t.id === 'hostex:a' ? 'CTX-A' : null));
    const generate = vi.fn().mockResolvedValue({ kind: 'text', body: 'REPLY' });
    const d = deps({
      getThreads: vi.fn().mockReturnValue([threadA, threadB]),
      buildBookingContext,
      generate,
    });

    await generateDraftsForProperty(property, d);

    expect(buildBookingContext).toHaveBeenCalledWith(threadA);
    expect(buildBookingContext).toHaveBeenCalledWith(threadB);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ thread: threadA, bookingContext: 'CTX-A' }));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ thread: threadB, bookingContext: null }));
  });
});

describe('Auto-Send-Gate in der Kette', () => {
  it('ruft das Gate nach jedem erzeugten Entwurf mit Draft-Id und Kontext', async () => {
    const d = deps({ getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]) });
    await generateDraftsForProperty(property, d);
    expect(d.gate).toHaveBeenCalledTimes(1);
    const arg = (d.gate as any).mock.calls[0][0];
    expect(arg).toMatchObject({ body: 'REPLY', voice: 'VOICE', facts: 'FACTS', property });
    expect(arg.draftId).toBe((d.create as any).mock.calls[0][0].id);
  });
  it('Gate-Fehler bricht die Kette nicht ab', async () => {
    const d = deps({ gate: vi.fn().mockRejectedValue(new Error('gate down')) });
    const res = await generateDraftsForProperty(property, d);
    expect(res.generated).toBe(2);
  });
  it('onlyThreadIds filtert', async () => {
    const d = deps();
    await generateDraftsForProperty(property, d, { onlyThreadIds: ['hostex:b'] });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect((d.create as any).mock.calls[0][0].thread_id).toBe('hostex:b');
  });
  it('onlyThreadIds holt mit Limit 100 statt dem 10er-Cap (Webhook-Thread nicht abgeschnitten)', async () => {
    const d = deps();
    await generateDraftsForProperty(property, d, { onlyThreadIds: ['hostex:b'] });
    expect(d.getThreads).toHaveBeenCalledWith('hostex', 'L1', 100, DRAFT_SINCE_MODIFIER);
  });
});

// #695: automatischer Neuversuch bei language_mismatch (Spec Punkt 3, Fall Lorenzo U19 20.09.2026).
describe('Sprach-Pin — automatischer Neuversuch bei language_mismatch (#695)', () => {
  const englishInboundMessages = [
    { id: 'm1', direction: 'inbound', body: 'Thanks so much, all good! 🙏', sent_at: '2026-09-20T10:00:00Z' },
  ] as any;

  it('mechanischer language_mismatch → genau ein Neuversuch, Draft-Body wird ersetzt, Gate läuft erneut mit attempt=2', async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ decision: { decision: 'wait', reason: 'Mechanischer Check: falsche Sprache', category: null, flags: ['mech:language_mismatch'] }, mode: 'live', sent: false })
      .mockResolvedValueOnce({ decision: { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, mode: 'live', sent: true });
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: 'text', body: 'Hallo, danke dir!' })
      .mockResolvedValueOnce({ kind: 'text', body: 'Hi, thanks a lot!' });
    const updateDraftBody = vi.fn();
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate, updateDraftBody,
    });

    const res = await generateDraftsForProperty(property, d);

    expect(res).toEqual({ generated: 1, skipped: 0 });
    expect(d.create).toHaveBeenCalledTimes(1); // kein zweiter Draft-Datensatz für den Neuversuch
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0]).toMatchObject({ guestLanguage: 'en' });
    expect(generate.mock.calls[0][0].languageRetry).toBeFalsy();
    expect(generate.mock.calls[1][0]).toMatchObject({ guestLanguage: 'en', languageRetry: true });
    const draftId = (d.create as any).mock.calls[0][0].id;
    expect(updateDraftBody).toHaveBeenCalledWith(draftId, 'Hi, thanks a lot!');
    expect(gate).toHaveBeenCalledTimes(2);
    expect(gate.mock.calls[0][0]).toMatchObject({ draftId, body: 'Hallo, danke dir!' });
    expect(gate.mock.calls[0][0].attempt).toBeFalsy();
    expect(gate.mock.calls[1][0]).toMatchObject({ draftId, body: 'Hi, thanks a lot!', attempt: 2 });
  });

  it('vom Prüfmodell erkannter language_mismatch (ohne mech:-Präfix) löst denselben Neuversuch aus', async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ decision: { decision: 'wait', reason: 'Prüfmodell: falsche Sprache', category: 'dank_smalltalk', flags: ['language_mismatch'] }, mode: 'live', sent: false })
      .mockResolvedValueOnce({ decision: { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, mode: 'live', sent: true });
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: 'text', body: 'Hallo, danke dir!' })
      .mockResolvedValueOnce({ kind: 'text', body: 'Hi, thanks a lot!' });
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate,
    });

    await generateDraftsForProperty(property, d);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('mismatcht auch der zweite Versuch, bleibt es bei wait — kein dritter Anlauf', async () => {
    const gate = vi.fn().mockResolvedValue({ decision: { decision: 'wait', reason: 'falsche Sprache', category: null, flags: ['mech:language_mismatch'] }, mode: 'live', sent: false });
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: 'text', body: 'Hallo, danke dir!' })
      .mockResolvedValueOnce({ kind: 'text', body: 'Hallo nochmal!' });
    const updateDraftBody = vi.fn();
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate, updateDraftBody,
    });

    const res = await generateDraftsForProperty(property, d);

    expect(res).toEqual({ generated: 1, skipped: 0 });
    expect(generate).toHaveBeenCalledTimes(2); // nicht 3 — genau EIN Neuversuch
    expect(gate).toHaveBeenCalledTimes(2);
    expect(updateDraftBody).toHaveBeenCalledTimes(1);
  });

  it('kein Neuversuch bei anderen Wait-Gründen (z. B. Kategorie Geld)', async () => {
    const gate = vi.fn().mockResolvedValue({ decision: { decision: 'wait', reason: 'Kategorie Geld — nie automatisch', category: 'geld', flags: [] }, mode: 'live', sent: false });
    const generate = vi.fn().mockResolvedValue({ kind: 'text', body: 'Hallo, danke dir!' });
    const updateDraftBody = vi.fn();
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate, updateDraftBody,
    });

    await generateDraftsForProperty(property, d);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(updateDraftBody).not.toHaveBeenCalled();
  });

  it('kein Neuversuch/kein Gate-Aufruf bei no_reply — unverändertes Verhalten (Akzeptanzkriterium)', async () => {
    const gate = vi.fn();
    const updateDraftBody = vi.fn();
    const generate = vi.fn().mockResolvedValue({ kind: 'no_reply', reason: 'reine Dankesnachricht' });
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate, updateDraftBody,
    });

    const res = await generateDraftsForProperty(property, d);

    expect(res).toEqual({ generated: 0, skipped: 1 });
    expect(gate).not.toHaveBeenCalled();
    expect(updateDraftBody).not.toHaveBeenCalled();
  });

  it('kein Neuversuch/kein Gate-Aufruf bei failed — unverändertes Verhalten (Akzeptanzkriterium)', async () => {
    const gate = vi.fn();
    const updateDraftBody = vi.fn();
    const generate = vi.fn().mockResolvedValue({ kind: 'failed', error: 'kaputt' });
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate, updateDraftBody,
    });

    const res = await generateDraftsForProperty(property, d);

    expect(res).toEqual({ generated: 0, skipped: 1 });
    expect(gate).not.toHaveBeenCalled();
    expect(updateDraftBody).not.toHaveBeenCalled();
  });

  it('Gate-Fehler beim Neuversuch bricht die Kette nicht ab', async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ decision: { decision: 'wait', reason: 'falsche Sprache', category: null, flags: ['mech:language_mismatch'] }, mode: 'live', sent: false })
      .mockRejectedValueOnce(new Error('gate down'));
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: 'text', body: 'Hallo, danke dir!' })
      .mockResolvedValueOnce({ kind: 'text', body: 'Hi, thanks a lot!' });
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]),
      getMessages: vi.fn().mockReturnValue(englishInboundMessages),
      generate, gate,
    });

    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 1, skipped: 0 });
  });
});

describe('resolveDraftSource', () => {
  it('maps providers to (source, listingId)', () => {
    expect(resolveDraftSource({ provider: 'hostex', hostexPropertyId: 'H1' } as unknown as PropertyConfig))
      .toEqual({ source: 'hostex', listingId: 'H1' });
    expect(resolveDraftSource({ provider: 'guesty', guestyPropertyId: 'G1' } as unknown as PropertyConfig))
      .toEqual({ source: 'guesty', listingId: 'G1' });
    expect(resolveDraftSource({ provider: 'airbnb-mail' } as unknown as PropertyConfig)).toBeNull();
    expect(resolveDraftSource({ provider: 'guesty' } as unknown as PropertyConfig)).toBeNull();
  });
});
