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
    expect((d.getThreads as any)).toHaveBeenCalledWith('hostex', 'L1', DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER);
  });

  it('generates drafts for a guesty property with provider=guesty', async () => {
    const created: NewDraft[] = [];
    const d = deps({
      getThreads: vi.fn().mockReturnValue([mkThread('guesty:t1')]),
      create: (draft) => { created.push(draft); },
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
