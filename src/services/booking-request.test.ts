import { describe, it, expect } from 'vitest';
import { findOpenBookingRequest } from './booking-request.js';
import type { Message } from '../types/messages.js';

const msg = (over: Partial<Message>): Message => ({
  id: 'm', thread_id: 't', direction: 'inbound', sent_at: '2026-09-21T20:00:00.000Z',
  from_name: null, from_address: null, to_address: null, subject: null, body: '', body_html: null,
  source: 'guesty', raw_meta: null, ...over,
});

describe('findOpenBookingRequest (#697/#702, Fall Anika)', () => {
  it('Request-to-Book-System-Post nach der Gastnachricht, unbestätigt → request_to_book, Frist +24h', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Hallo, ich würde gern für ein Event buchen.', sent_at: '2026-09-21T20:34:58.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sent_at: '2026-09-21T20:35:04.000Z' }),
    ];
    const ctx = findOpenBookingRequest(messages, null);
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
    expect(findOpenBookingRequest(messages, null)?.requestKind).toBe('inquiry');
  });

  it('andere System-Posts (Statuswechsel) lösen nichts aus', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'Reservation HMYYFAMPH8 status changed to confirmed', sent_at: '2026-09-21T10:05:00.000Z' }),
    ];
    expect(findOpenBookingRequest(messages, null)).toBeNull();
  });

  it('kein System-Post im Thread → null', () => {
    const messages: Message[] = [msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' })];
    expect(findOpenBookingRequest(messages, null)).toBeNull();
  });

  it('mehrere passende System-Posts → der jüngste zählt', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Frage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:00:05.000Z' }),
      msg({ id: 'm3', direction: 'system', body: 'New guest reservation request ABC123', sent_at: '2026-09-21T11:00:00.000Z' }),
    ];
    expect(findOpenBookingRequest(messages, null)).toMatchObject({ requestKind: 'request_to_book', systemMessageId: 'm3' });
  });

  // #702: reservationStatus entscheidet, nicht die Position des System-Posts.
  it('reservationStatus confirmed → null, obwohl ein System-Post im Thread steht', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Anfrage', sent_at: '2026-09-21T10:00:00.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest reservation request ABC123', sent_at: '2026-09-21T10:05:00.000Z' }),
    ];
    expect(findOpenBookingRequest(messages, 'confirmed')).toBeNull();
  });

  it('reservationStatus reserved → null (deckungsgleich mit reservation-repository.ts)', () => {
    const messages: Message[] = [
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:05:00.000Z' }),
    ];
    expect(findOpenBookingRequest(messages, 'reserved')).toBeNull();
  });

  it('reservationStatus null/unbekannt → weiter offen (konservativ)', () => {
    const messages: Message[] = [
      msg({ id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-09-21T10:05:00.000Z' }),
    ];
    expect(findOpenBookingRequest(messages, null)).not.toBeNull();
    expect(findOpenBookingRequest(messages, 'irgendwas')).not.toBeNull();
  });

  // #702 Fall Anika: System-Post liegt VOR mehreren späteren Gastnachrichten (Rückfrage +
  // Antwort des Gastes) — zählt trotzdem, solange die Anfrage offen ist.
  it('System-Post liegt lange vor der aktuellen letzten Gastnachricht → weiterhin erkannt, solange offen', () => {
    const messages: Message[] = [
      msg({ id: 'm1', direction: 'inbound', body: 'Ich würde gern für ein Event buchen.', sent_at: '2026-09-20T20:34:58.000Z' }),
      msg({ id: 'm2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sent_at: '2026-09-20T20:35:04.000Z' }),
      msg({ id: 'm3', direction: 'outbound', body: 'Magst du uns sagen, um welchen Anlass es geht?', sent_at: '2026-09-21T09:01:00.000Z' }),
      msg({ id: 'm4', direction: 'inbound', body: 'Gemütliche Runde nach dem Geburtstag, wir kochen und machen Yoga.', sent_at: '2026-09-21T09:39:00.000Z' }),
    ];
    const ctx = findOpenBookingRequest(messages, null);
    expect(ctx).toMatchObject({ requestKind: 'request_to_book', systemMessageId: 'm2', platformDeadlineAt: '2026-09-21T20:35:04.000Z' });
  });
});
