// src/mappers/hostex/message-mapper.test.ts
import { describe, it, expect } from 'vitest';
import {
  mapHostexDirection, mapHostexChannel, mapHostexConversation, detailBelongsToProperty,
} from './message-mapper.js';
import type { HostexConversationDetail } from '../../services/hostex-client.js';

describe('hostex message mapper', () => {
  it('maps sender role to direction', () => {
    expect(mapHostexDirection('guest')).toBe('inbound');
    expect(mapHostexDirection('host')).toBe('outbound');
    expect(mapHostexDirection('automation')).toBe('system');
  });

  it('maps channel_type to internal channel', () => {
    expect(mapHostexChannel('airbnb')).toBe('airbnb');
    expect(mapHostexChannel('booking.com')).toBe('booking.com');
    expect(mapHostexChannel('manual')).toBe('manual');
    expect(mapHostexChannel('whatever')).toBe('other');
  });

  it('maps a conversation to thread + messages with stable ids, filtering non-Text', () => {
    const detail: HostexConversationDetail = {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
        { id: 'm-2', sender_role: 'host', display_type: 'Text', content: 'Hi', created_at: '2026-06-30T11:00:00Z' },
        { id: 'm-3', sender_role: 'guest', display_type: 'ReservationAlteration', content: '', created_at: '2026-06-30T12:00:00Z' },
      ],
    };
    const { thread, messages } = mapHostexConversation(detail, 'listing-9', '2026-07-01T00:00:00Z');

    expect(thread.id).toBe('hostex:c-1');
    expect(thread.listing_id).toBe('listing-9');
    expect(thread.source).toBe('hostex');
    expect(thread.channel).toBe('airbnb');
    expect(thread.guest_name).toBe('Darleen');
    expect(thread.message_count).toBe(2); // only Text messages counted
    expect(thread.first_message_at).toBe('2026-06-30T10:00:00Z');
    // #577: last_message_at reflects the conversation's real last activity across ALL
    // message types (incl. the ReservationAlteration system card, m-3 at 12:00) — not just
    // Text messages — so a thread with only system activity after the last chat message
    // doesn't look stale/inactive.
    expect(thread.last_message_at).toBe('2026-06-30T12:00:00Z');

    // the ReservationAlteration system card (m-3) is still filtered out of the persisted
    // messages (only real chat text is stored as a Message row)
    expect(messages.map((m) => m.id)).toEqual(['hostex:m-1', 'hostex:m-2']);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].thread_id).toBe('hostex:c-1');
    expect(messages[0].body).toBe('Hallo');
    expect(messages[0].source).toBe('hostex');
  });

  // #577 (Standup 09.09.2026): Live-Befund — GET /threads zeigte 14 Hostex-Threads mit
  // lastMessageAt "jetzt", aber GET /threads/:id lieferte messages: []. Root cause: Hostex
  // erzeugt für jede Reservierung/Anfrage eine Conversation, auch ohne echten Gast-Chat
  // (nur System-Karten wie "Box"/"ReservationAlteration", z. B. Stornierungen) — die alte
  // Fallback-Logik nahm dafür den SYNC-Zeitpunkt (`now`) statt der echten Aktivitätszeit,
  // wodurch der Thread bei JEDEM Sync-Lauf erneut als "gerade eben aktiv" erschien und so
  // in jedes `since=`-Zeitfenster rutschte (verifiziert live gegen die Hostex-API: mehrere
  // Bootshaus/Schilderwerkstatt-Conversations aus dem Standup-Befund hatten tatsächlich
  // keine Text-Nachricht, nur eine ältere Box-Karte — z. B. "The reservation has been
  // cancelled" vom 2026-08-29).
  it('#577: falls back to the last system-card timestamp, not sync time, when there are no Text messages', () => {
    const detail: HostexConversationDetail = {
      id: 'c-2', channel_type: 'airbnb', guest: { name: 'Tanith', email: '' },
      messages: [
        {
          id: 'm-cancel', sender_role: 'guest', display_type: 'Box',
          content: 'The reservation has been cancelled.', created_at: '2026-08-29T20:36:36Z',
        },
      ],
    };
    const { thread, messages } = mapHostexConversation(detail, 'listing-9', '2026-09-09T02:40:20.073Z');

    expect(thread.message_count).toBe(0); // no real chat text
    expect(thread.first_message_at).toBe('2026-08-29T20:36:36Z');
    expect(thread.last_message_at).toBe('2026-08-29T20:36:36Z'); // NOT the sync time
    expect(messages).toEqual([]);
  });

  // #577-Nachfix (10.09.2026, Rest-Befund): 9 Bootshaus-/Schilderwerkstatt-Threads
  // hatten trotz #577 weiterhin `now` als last_message_at, weil ihre Hostex-
  // Conversation ÜBERHAUPT keine messages[] hat (nicht mal eine System-Karte) —
  // Live-Beispiel hostex:0-2660304253 (Julie Winkel): DETAIL liefert `messages: []`
  // und KEIN eigenes Zeitfeld, aber die LIST-Antwort führt dafür `last_message_at`
  // (echte Hostex-Aktivität, z. B. Stornierung/Alteration) — dieser Wert kommt vom
  // Aufrufer (sync-hostex-messages.ts) als `conversationLastMessageAt` herein.
  it('#577-Nachfix: uses the LIST conversation last_message_at when there are no messages at all', () => {
    const detail: HostexConversationDetail = {
      id: 'c-3', channel_type: 'airbnb', guest: { name: 'Julie Winkel', email: '' },
      messages: [],
    };
    const { thread, messages } = mapHostexConversation(
      detail, 'listing-9', '2026-09-10T02:27:16Z', null, '2026-09-07T18:34:38+00:00',
    );

    expect(thread).not.toBeNull();
    expect(thread?.message_count).toBe(0);
    expect(thread?.first_message_at).toBe('2026-09-07T18:34:38+00:00');
    expect(thread?.last_message_at).toBe('2026-09-07T18:34:38+00:00'); // NOT the sync time
    expect(messages).toEqual([]);
  });

  // Liefert auch die LIST-Antwort kein last_message_at (Hostex-Feld fehlt/ist null) —
  // die Conversation trägt dann keine Information (weder Nachricht noch Aktivitäts-
  // Zeitstempel): kein Thread-Objekt statt `now` zu erfinden. first_message_at/
  // last_message_at bleiben NOT NULL (Migration 014) — ein Table-Rebuild dafür ist mit
  // dem bestehenden Migrations-Runner bei aktiven Fremdschlüsseln nicht sicher machbar
  // (Review-Befund 10.09.2026: DROP TABLE würde die ON DELETE CASCADE-Trigger von
  // messages/message_drafts feuern und in Produktion alle Nachrichten/Drafts löschen).
  it('#577-Nachfix: liefert keinen Thread, wenn weder Nachrichten noch ein brauchbarer Hostex-Zeitstempel existieren', () => {
    const detail: HostexConversationDetail = {
      id: 'c-4', channel_type: 'airbnb', guest: { name: 'Ohne Aktivität', email: '' },
      messages: [],
    };
    const { thread, messages } = mapHostexConversation(detail, 'listing-9', '2026-09-09T02:40:20.073Z');

    expect(thread).toBeNull();
    expect(messages).toEqual([]);
  });

  it('detailBelongsToProperty matches on numeric activities property id (incl. string/number)', () => {
    const detail = {
      id: 'x', channel_type: 'airbnb', guest: null, property_title: '',
      activities: [{ activity_type: 'inquiry', property: { id: 12659676, title: 'Alte Schilderwerkstatt' } }],
      messages: [],
    } as unknown as HostexConversationDetail;
    expect(detailBelongsToProperty(detail, '12659676')).toBe(true); // string hostexPropertyId vs number id
    expect(detailBelongsToProperty(detail, '99999999')).toBe(false);
  });

  it('detailBelongsToProperty is false when there are no activities', () => {
    const detail = {
      id: 'x', channel_type: 'airbnb', guest: null, property_title: '', messages: [],
    } as unknown as HostexConversationDetail;
    expect(detailBelongsToProperty(detail, '12659676')).toBe(false);
  });

  // #441 Root-Cause-Fix: reservation_status/reservation_id/inquiry_id used to be hardcoded to
  // null — the mapper now takes the resolved reservation info as an explicit (optional) param,
  // set by the caller (sync-hostex-messages.ts) via a local DB lookup. Kept as a plain injected
  // value (not a lookup inside the mapper) so the mapper itself stays pure and unit-testable.
  describe('reservation status (#441)', () => {
    const baseDetail: HostexConversationDetail = {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
      ],
    };

    it('defaults to null (no reservation info passed) — unchanged pre-#441 behavior', () => {
      const { thread } = mapHostexConversation(baseDetail, 'listing-9', '2026-07-01T00:00:00Z');
      expect(thread.reservation_id).toBeNull();
      expect(thread.inquiry_id).toBeNull();
      expect(thread.reservation_status).toBeNull();
    });

    it('writes reservation_id/inquiry_id/reservation_status from the injected lookup result', () => {
      const { thread } = mapHostexConversation(baseDetail, 'listing-9', '2026-07-01T00:00:00Z', {
        reservation_id: 'R-001', inquiry_id: 'R-001', reservation_status: 'confirmed',
      });
      expect(thread.reservation_id).toBe('R-001');
      expect(thread.inquiry_id).toBe('R-001');
      expect(thread.reservation_status).toBe('confirmed');
    });

    it('an explicit null lookup result (no match) leaves all three fields null', () => {
      const { thread } = mapHostexConversation(baseDetail, 'listing-9', '2026-07-01T00:00:00Z', null);
      expect(thread.reservation_id).toBeNull();
      expect(thread.inquiry_id).toBeNull();
      expect(thread.reservation_status).toBeNull();
    });
  });
});
