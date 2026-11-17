// #1234 (Fall Daniel): Einzelabruf der Anfragedaten beim Nachrichten-Eingang.
import { describe, it, expect, vi } from 'vitest';
import { prefetchInquiryForThread, INQUIRY_PREFETCH_TIMEOUT_MS, type InquiryPrefetchDeps } from './inquiry-prefetch.js';
import type { MessageThread } from '../types/messages.js';

function thread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 'guesty:c1', listing_id: 'L1', source: 'guesty', channel: 'airbnb2', guest_name: 'Daniel',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1,
    reservation_id: 'R1', inquiry_id: 'R1', reservation_status: 'inquiry', conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null,
    ai_no_reply_at: null, last_synced_at: '',
    ...over,
  };
}

function deps(over: Partial<InquiryPrefetchDeps> = {}): InquiryPrefetchDeps {
  return {
    getThread: vi.fn().mockReturnValue(thread()),
    hasReservation: vi.fn().mockReturnValue(false),
    hasInquiry: vi.fn().mockReturnValue(false),
    getReservation: vi.fn().mockResolvedValue({ _id: 'R1' }),
    upsertInquiry: vi.fn().mockReturnValue(1),
    ...over,
  };
}

describe('prefetchInquiryForThread (#1234)', () => {
  it('Thread verknüpft, keine Zeile → genau ein getReservation-Aufruf, Ergebnis wird geschrieben', async () => {
    const d = deps();
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('fetched');
    expect(d.getReservation).toHaveBeenCalledTimes(1);
    expect(d.getReservation).toHaveBeenCalledWith('R1');
    expect(d.upsertInquiry).toHaveBeenCalledWith({ _id: 'R1' });
  });

  it('inquiries-Zeile existiert → kein Abruf', async () => {
    const d = deps({ hasInquiry: vi.fn().mockReturnValue(true) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('exists');
    expect(d.getReservation).not.toHaveBeenCalled();
  });

  it('reservations-Zeile existiert → kein Abruf', async () => {
    const d = deps({ hasReservation: vi.fn().mockReturnValue(true) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('exists');
    expect(d.getReservation).not.toHaveBeenCalled();
  });

  it('nur inquiry_id gesetzt → Abruf mit dieser Id', async () => {
    const d = deps({ getThread: vi.fn().mockReturnValue(thread({ reservation_id: null, inquiry_id: 'I9' })) });
    await prefetchInquiryForThread('guesty:c1', d);
    expect(d.getReservation).toHaveBeenCalledWith('I9');
  });

  it('Thread ohne Verknüpfung oder unbekannt → kein Abruf', async () => {
    const d1 = deps({ getThread: vi.fn().mockReturnValue(thread({ reservation_id: null, inquiry_id: null })) });
    await expect(prefetchInquiryForThread('guesty:c1', d1)).resolves.toBe('not_linked');
    expect(d1.getReservation).not.toHaveBeenCalled();
    const d2 = deps({ getThread: vi.fn().mockReturnValue(null) });
    await expect(prefetchInquiryForThread('guesty:c1', d2)).resolves.toBe('no_thread');
    expect(d2.getReservation).not.toHaveBeenCalled();
  });

  it('Abruf wirft (z. B. 429) → wirft nicht weiter, nichts geschrieben', async () => {
    const d = deps({ getReservation: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('failed');
    expect(d.getReservation).toHaveBeenCalledTimes(1);
    expect(d.upsertInquiry).not.toHaveBeenCalled();
  });

  it('Abruf wirft synchron → wirft nicht weiter', async () => {
    const d = deps({ getReservation: vi.fn(() => { throw new Error('sync boom'); }) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('failed');
  });

  it('DB-Lookup wirft → wirft nicht weiter, kein Abruf', async () => {
    const d = deps({ hasInquiry: vi.fn(() => { throw new Error('db'); }) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('failed');
    expect(d.getReservation).not.toHaveBeenCalled();
  });

  it('Abruf hängt → Timeout, Eingang läuft weiter', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ getReservation: vi.fn(() => new Promise(() => {})) });
      const p = prefetchInquiryForThread('guesty:c1', d);
      await vi.advanceTimersByTimeAsync(INQUIRY_PREFETCH_TIMEOUT_MS + 1);
      await expect(p).resolves.toBe('failed');
      expect(d.upsertInquiry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Antwort ohne Pflichtfelder → unusable, kein Fehler', async () => {
    const d = deps({ upsertInquiry: vi.fn().mockReturnValue(0) });
    await expect(prefetchInquiryForThread('guesty:c1', d)).resolves.toBe('unusable');
  });
});
