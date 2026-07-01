import { describe, it, expect, vi } from 'vitest';
import { generateDraftsForProperty, DRAFT_GEN_CAP, type DraftGenDeps } from './generate-hostex-drafts.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { MessageThread } from '../../types/messages.js';

function mkThread(id: string): MessageThread {
  return {
    id, listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null, inquiry_id: null,
    reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}
const property = { slug: 'bootshaus', hostexPropertyId: 'L1', vaultNote: 'Bootshaus.md' } as unknown as PropertyConfig;

function deps(over: Partial<DraftGenDeps> = {}): DraftGenDeps {
  return {
    getThreads: vi.fn().mockReturnValue([mkThread('hostex:a'), mkThread('hostex:b')]),
    getMessages: vi.fn().mockReturnValue([]),
    loadVoice: vi.fn().mockReturnValue('VOICE'),
    loadFacts: vi.fn().mockReturnValue('FACTS'),
    generate: vi.fn().mockResolvedValue('REPLY'),
    create: vi.fn(),
    ...over,
  };
}

describe('generateDraftsForProperty', () => {
  it('creates one draft per needing-reply thread and reports counts', async () => {
    const d = deps();
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 2, skipped: 0 });
    expect(d.create).toHaveBeenCalledTimes(2);
    expect((d.getThreads as any)).toHaveBeenCalledWith('L1', DRAFT_GEN_CAP);
  });

  it('skips a thread when generate returns null', async () => {
    const d = deps({ generate: vi.fn().mockResolvedValueOnce('REPLY').mockResolvedValueOnce(null) });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 1, skipped: 1 });
    expect(d.create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when voice or facts are missing', async () => {
    const d = deps({ loadFacts: vi.fn().mockReturnValue(null) });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 0, skipped: 0 });
    expect(d.getThreads).not.toHaveBeenCalled();
  });

  it('is a no-op when the property has no vaultNote or hostexPropertyId', async () => {
    const d = deps();
    const bad = { slug: 'x', hostexPropertyId: 'L1' } as unknown as PropertyConfig;
    expect(await generateDraftsForProperty(bad, d)).toEqual({ generated: 0, skipped: 0 });
    expect(d.loadVoice).not.toHaveBeenCalled();
  });

  it('does not throw if generate rejects (counts as skipped)', async () => {
    const d = deps({ generate: vi.fn().mockRejectedValue(new Error('claude down')) });
    const res = await generateDraftsForProperty(property, d);
    expect(res.generated).toBe(0);
    expect(res.skipped).toBe(2);
  });
});
