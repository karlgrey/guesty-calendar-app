import { describe, it, expect } from 'vitest';
import { detectBookingRequestContext } from './booking-request.js';
import type { Message } from '../types/messages.js';

const msg = (over: Partial<Message>): Message => ({
  id: 'm', thread_id: 't', direction: 'inbound', sent_at: '2026-09-21T20:00:00.000Z',
  from_name: null, from_address: null, to_address: null, subject: null, body: '', body_html: null,
  source: 'guesty', raw_meta: null, ...over,
});

describe('detectBookingRequestContext (#697, Fall Anika)', () => {
  it('Request-to-Book-System-Post nach der Gastnachricht → request_to_book, Frist +24h', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Hallo, ich würde gern für ein Event buchen.', sent_at: '2026-09-21T20:34:58.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sent_at: '2026-09-21T20:35:04.000Z' }),
    ];
    const ctx = detectBookingRequestContext(messages);
    expect(ctx).toEqual({
      requestKind: 'request_to_book',
      systemMessageId: 'm2',
      systemMessageSentAt: '2026-09-21T20:35:04.000Z',
      platformDeadlineAt: '2026-09-22T20:35:04.000Z',
    });
  });

  it('Inquiry-System-Post (ohne Code) → inquiry', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Habt ihr das Wochenende frei?', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:00:05.000Z' }),
    ];
    expect(detectBookingRequestContext(messages)?.requestKind).toBe('inquiry');
  });

  it('System-Post VOR der Gastnachricht zählt nicht', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T09:00:00.000Z' }),
      msg({ id: 'm2', direction: 'inbound', body: 'Noch eine Frage dazu.', sent_at: '2026-09-21T10:00:00.000Z' }),
    ];
    expect(detectBookingRequestContext(messages)).toBeNull();
  });

  it('andere System-Posts (Statuswechsel) lösen nichts aus', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'Reservation HMYYFAMPH8 status changed to confirmed', sent_at: '2026-09-21T10:05:00.000Z' }),
    ];
    expect(detectBookingRequestContext(messages)).toBeNull();
  });

  it('keine Gastnachricht → null', () => {
    const messages: Message[] = [msg({ id: 'm1', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:00:00.000Z' })];
    expect(detectBookingRequestContext(messages)).toBeNull();
  });

  it('Host-Antwort nach dem System-Post gilt trotzdem, solange der Post nach der letzten Gastnachricht kam', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:00:05.000Z' }),
    ];
    expect(detectBookingRequestContext(messages)?.requestKind).toBe('inquiry');
  });

  it('mehrere passende System-Posts nach der Gastnachricht → der jüngste zählt', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:00:05.000Z' }),
      msg({ id: 'm3', direction: 'system', body: 'New guest reservation request ABC123', sent_at: '2026-09-21T11:00:00.000Z' }),
    ];
    expect(detectBookingRequestContext(messages)).toMatchObject({ requestKind: 'request_to_book', systemMessageId: 'm3' });
  });
});
