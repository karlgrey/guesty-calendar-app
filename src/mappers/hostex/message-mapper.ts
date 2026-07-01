// src/mappers/hostex/message-mapper.ts
import type { HostexConversationDetail } from '../../services/hostex-client.js';
import type { NewMessageThread, NewMessage, MessageChannel } from '../../types/messages.js';

export function mapHostexDirection(senderRole: string): 'inbound' | 'outbound' | 'system' {
  if (senderRole === 'guest') return 'inbound';
  if (senderRole === 'host') return 'outbound';
  return 'system';
}

/**
 * Whether a conversation DETAIL belongs to the given Hostex property, matched on
 * the numeric `activities[].property.id`. This is the reliable attribution key —
 * unlike the LIST item's `property_title`, it is present even for inquiries
 * (which carry no property_title). Returns false when no activity resolves.
 */
export function detailBelongsToProperty(
  detail: HostexConversationDetail,
  hostexPropertyId: string,
): boolean {
  return (detail.activities ?? []).some(
    (a) => a.property?.id != null && String(a.property.id) === String(hostexPropertyId),
  );
}

export function mapHostexChannel(channelType: string): MessageChannel {
  const s = (channelType ?? '').toLowerCase();
  if (s === 'airbnb' || s === 'airbnb2') return 'airbnb';
  if (s === 'booking.com' || s === 'bookingcom') return 'booking.com';
  if (s.startsWith('vrbo')) return 'vrbo';
  if (s === 'manual') return 'manual';
  return 'other';
}

export function mapHostexConversation(
  detail: HostexConversationDetail,
  listingId: string,
  now: string,
): { thread: NewMessageThread; messages: NewMessage[] } {
  const threadId = `hostex:${detail.id}`;
  // Only 'Text' messages are real guest/host conversation; 'Box' and
  // 'ReservationAlteration' are system cards (Task-1-Fixture bestätigt).
  const posts = (detail.messages ?? []).filter((p) => p.display_type === 'Text');
  const guestName = detail.guest?.name ?? null;
  const times = posts.map((p) => p.created_at).filter(Boolean).sort();
  const firstAt = times[0] ?? now;
  const lastAt = times[times.length - 1] ?? now;

  const thread: NewMessageThread = {
    id: threadId,
    listing_id: listingId,
    source: 'hostex',
    channel: mapHostexChannel(detail.channel_type),
    guest_name: guestName,
    guest_email: null,
    first_message_at: firstAt,
    last_message_at: lastAt,
    message_count: posts.length,
    reservation_id: null,
    inquiry_id: null,
    reservation_status: null,
    conversion_category: null,
    classification_confidence: null,
    classification_keywords: null,
    raw_meta: JSON.stringify({ channel_type: detail.channel_type }),
    last_synced_at: now,
  };

  const messages: NewMessage[] = posts.map((p) => ({
    id: `hostex:${p.id}`,
    thread_id: threadId,
    direction: mapHostexDirection(p.sender_role),
    sent_at: p.created_at ?? now,
    from_name: p.sender_role === 'host' ? 'host' : guestName,
    from_address: null,
    to_address: null,
    subject: null,
    body: p.content ?? '',
    body_html: null,
    source: 'hostex',
    raw_meta: JSON.stringify({ sender_role: p.sender_role }),
  }));

  return { thread, messages };
}
