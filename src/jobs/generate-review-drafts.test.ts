import { describe, it, expect, vi } from 'vitest';
import { generateReviewDraftsForProperty, resolveReviewSource, REVIEW_DRAFT_CAP, REVIEW_SINCE_MODIFIER, type ReviewDraftGenDeps } from './generate-review-drafts.js';
import type { PropertyConfig } from '../config/properties.js';
import type { Reservation } from '../types/models.js';
import type { Message, MessageThread } from '../types/messages.js';
import type { NewReviewDraft } from '../types/reviews.js';

function mkReservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 1, reservation_id: 'res-1', listing_id: 'L1', check_in: '2026-08-01', check_out: '2026-08-05',
    check_in_localized: '2026-08-01', check_out_localized: '2026-08-05', nights_count: 4,
    guest_id: null, guest_name: 'Darleen', guests_count: 2, adults_count: 2, children_count: 0, infants_count: 0,
    status: 'confirmed', confirmation_code: 'ABC', source: 'airbnb2', platform: 'airbnb2',
    planned_arrival: null, planned_departure: null, currency: 'EUR', total_price: 400, host_payout: 350,
    balance_due: null, total_paid: null, created_at_guesty: null, reserved_at: null, last_synced_at: '',
    internal_guest_id: null, guest_company: null,
    ...over,
  } as Reservation;
}

function mkThread(id: string): MessageThread {
  return {
    id, listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'Darleen', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null, inquiry_id: null,
    reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}

function mkMessage(threadId: string, direction: Message['direction'], body: string, sentAt = '2026-08-01T10:00:00Z'): Message {
  return { id: `m-${threadId}-${body.slice(0, 5)}`, thread_id: threadId, direction, sent_at: sentAt, from_name: null, from_address: null, to_address: null, subject: null, body, body_html: null, source: 'hostex', raw_meta: null };
}

const hostexProperty = { slug: 'bootshaus', name: 'Bootshaus', provider: 'hostex', hostexPropertyId: 'L1' } as unknown as PropertyConfig;
const guestyProperty = { slug: 'farmhouse', name: 'Farmhouse', provider: 'guesty', guestyPropertyId: 'GL1' } as unknown as PropertyConfig;

function deps(over: Partial<ReviewDraftGenDeps> = {}): ReviewDraftGenDeps {
  return {
    getCheckoutIds: vi.fn().mockReturnValue(['res-1']),
    getReservation: vi.fn().mockReturnValue(mkReservation()),
    getThreadsByReservation: vi.fn().mockReturnValue([]),
    getThreadsByGuestName: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockReturnValue([]),
    loadVoice: vi.fn().mockReturnValue('VOICE'),
    classify: vi.fn().mockResolvedValue({ classification: 'ok', reasoning: 'nothing stood out' }),
    generate: vi.fn().mockResolvedValue('Toller Gast!'),
    create: vi.fn(),
    ...over,
  };
}

describe('resolveReviewSource', () => {
  it('maps guesty/hostex providers to (source, listingId) and excludes everything else', () => {
    expect(resolveReviewSource({ provider: 'hostex', hostexPropertyId: 'H1' } as unknown as PropertyConfig))
      .toEqual({ source: 'hostex', listingId: 'H1' });
    expect(resolveReviewSource({ provider: 'guesty', guestyPropertyId: 'G1' } as unknown as PropertyConfig))
      .toEqual({ source: 'guesty', listingId: 'G1' });
    // Florenz/Manifattura runs on provider='airbnb-mail' — no reply channel, no review drafts (design decision 11.08.2026).
    expect(resolveReviewSource({ provider: 'airbnb-mail' } as unknown as PropertyConfig)).toBeNull();
    expect(resolveReviewSource({ provider: 'guesty' } as unknown as PropertyConfig)).toBeNull();
  });
});

describe('generateReviewDraftsForProperty', () => {
  it('is a no-op when voice is missing', async () => {
    const d = deps({ loadVoice: vi.fn().mockReturnValue(null) });
    expect(await generateReviewDraftsForProperty(hostexProperty, d)).toEqual({ generated: 0, flagged: 0, skipped: 0 });
    expect(d.getCheckoutIds).not.toHaveBeenCalled();
  });

  it('is a no-op for a property with no review source (e.g. airbnb-mail)', async () => {
    const d = deps();
    const airbnbMail = { slug: 'firenze', provider: 'airbnb-mail' } as unknown as PropertyConfig;
    expect(await generateReviewDraftsForProperty(airbnbMail, d)).toEqual({ generated: 0, flagged: 0, skipped: 0 });
    expect(d.loadVoice).not.toHaveBeenCalled();
  });

  it('creates a pending draft for an ok-classified stay with a thread (guesty: reservation_id lookup)', async () => {
    const thread = mkThread('guesty:t1');
    const messages = [mkMessage('guesty:t1', 'inbound', 'Danke für den tollen Aufenthalt!')];
    const create = vi.fn();
    const d = deps({
      getThreadsByReservation: vi.fn().mockReturnValue([thread]),
      getMessages: vi.fn().mockReturnValue(messages),
      create,
    });
    const res = await generateReviewDraftsForProperty(guestyProperty, d);
    expect(res).toEqual({ generated: 1, flagged: 0, skipped: 0 });
    expect(d.getThreadsByReservation).toHaveBeenCalledWith('res-1');
    expect(d.classify).toHaveBeenCalledWith({ messages: [{ direction: 'inbound', body: 'Danke für den tollen Aufenthalt!' }] });
    const created = create.mock.calls[0][0] as NewReviewDraft;
    expect(created.status).toBe('pending');
    expect(created.body).toBe('Toller Gast!');
    expect(created.reservation_id).toBe('res-1');
    expect(created.provider).toBe('guesty');
  });

  it('falls back to guest-name matching for hostex (no reservation_id on threads)', async () => {
    const thread = mkThread('hostex:t1');
    const d = deps({ getThreadsByGuestName: vi.fn().mockReturnValue([thread]), getMessages: vi.fn().mockReturnValue([mkMessage('hostex:t1', 'inbound', 'Hi!')]) });
    await generateReviewDraftsForProperty(hostexProperty, d);
    expect(d.getThreadsByGuestName).toHaveBeenCalledWith('L1', 'Darleen');
    expect(d.getThreadsByReservation).not.toHaveBeenCalled();
  });

  it('skips the LLM classifier and treats a threadless stay as ok (auto-classified)', async () => {
    const d = deps({ getThreadsByGuestName: vi.fn().mockReturnValue([]) });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 1, flagged: 0, skipped: 0 });
    expect(d.classify).not.toHaveBeenCalled();
    expect(d.generate).toHaveBeenCalledTimes(1);
  });

  it('still drafts a review for a flagged (problem-case) stay — pending status, flag_reason set, prompt marked flagged', async () => {
    const d = deps({
      getThreadsByGuestName: vi.fn().mockReturnValue([mkThread('hostex:t1')]),
      getMessages: vi.fn().mockReturnValue([mkMessage('hostex:t1', 'inbound', 'Die Heizung ging nicht!')]),
      classify: vi.fn().mockResolvedValue({ classification: 'flagged', reasoning: 'Beschwerde über Heizung.' }),
      generate: vi.fn().mockResolvedValue('Ein unkomplizierter, kurzer Aufenthalt.'),
    });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 1, flagged: 0, skipped: 0 });
    expect(d.generate).toHaveBeenCalledWith(expect.objectContaining({ flagged: true }));
    const created = (d.create as any).mock.calls[0][0] as NewReviewDraft;
    expect(created.status).toBe('pending');
    expect(created.body).toBe('Ein unkomplizierter, kurzer Aufenthalt.');
    expect(created.flag_reason).toBe('Beschwerde über Heizung.');
  });

  it('falls back to needs_review (no body) when the LLM fails to produce text for a flagged stay', async () => {
    const d = deps({
      getThreadsByGuestName: vi.fn().mockReturnValue([mkThread('hostex:t1')]),
      getMessages: vi.fn().mockReturnValue([mkMessage('hostex:t1', 'inbound', 'Die Heizung ging nicht!')]),
      classify: vi.fn().mockResolvedValue({ classification: 'flagged', reasoning: 'Beschwerde über Heizung.' }),
      generate: vi.fn().mockResolvedValue(null),
    });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 0, flagged: 1, skipped: 0 });
    const created = (d.create as any).mock.calls[0][0] as NewReviewDraft;
    expect(created.status).toBe('needs_review');
    expect(created.body).toBeNull();
    // needs_review keeps the classifier's reasoning — still the most useful signal for manual review.
    expect(created.flag_reason).toBe('Beschwerde über Heizung.');
  });

  it('passes flagged=false to generate for an ok-classified stay', async () => {
    const d = deps();
    await generateReviewDraftsForProperty(hostexProperty, d);
    expect(d.generate).toHaveBeenCalledWith(expect.objectContaining({ flagged: false }));
  });

  it('creates a needs_review draft when the LLM fails to produce review text for an ok stay', async () => {
    const d = deps({ generate: vi.fn().mockResolvedValue(null) });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 0, flagged: 1, skipped: 0 });
    const created = (d.create as any).mock.calls[0][0] as NewReviewDraft;
    expect(created.status).toBe('needs_review');
    expect(created.flag_reason).toMatch(/LLM konnte keine Bewertung erzeugen/);
  });

  it('does not throw and counts as skipped when a reservation lookup returns null', async () => {
    const d = deps({ getReservation: vi.fn().mockReturnValue(null) });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 0, flagged: 0, skipped: 1 });
    expect(d.create).not.toHaveBeenCalled();
  });

  it('does not throw and counts as skipped when classify rejects', async () => {
    const d = deps({
      getThreadsByGuestName: vi.fn().mockReturnValue([mkThread('hostex:t1')]),
      getMessages: vi.fn().mockReturnValue([mkMessage('hostex:t1', 'inbound', 'hi')]),
      classify: vi.fn().mockRejectedValue(new Error('claude down')),
    });
    const res = await generateReviewDraftsForProperty(hostexProperty, d);
    expect(res).toEqual({ generated: 0, flagged: 0, skipped: 1 });
  });

  it('passes REVIEW_DRAFT_CAP and REVIEW_SINCE_MODIFIER through to getCheckoutIds', async () => {
    const d = deps();
    await generateReviewDraftsForProperty(hostexProperty, d);
    expect(d.getCheckoutIds).toHaveBeenCalledWith('L1', REVIEW_SINCE_MODIFIER, REVIEW_DRAFT_CAP);
  });
});
