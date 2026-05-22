/**
 * Message + Thread types for unified conversation history.
 *
 * Sources: Guesty conversations API (channel = airbnb / booking.com / …)
 *          and direct-email IMAP label (channel = 'direct_email').
 *
 * See migration 014_add_messages_threads.sql.
 */

export type MessageSource = 'guesty' | 'gmail';

export type MessageChannel =
  | 'airbnb'
  | 'booking.com'
  | 'vrbo'
  | 'direct_email'
  | 'manual'
  | 'landfolk'
  | 'meetreet'
  | 'other';

export type MessageDirection = 'inbound' | 'outbound' | 'system';

export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'SPAM'
  | 'COMMERCIAL'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'NO_AVAILABILITY'
  | 'INFO'
  | 'PLAN_CHANGE'
  | 'OTHER';

export interface MessageThread {
  id: string;
  listing_id: string;
  source: MessageSource;
  channel: MessageChannel;
  guest_name: string | null;
  guest_email: string | null;
  first_message_at: string;
  last_message_at: string;
  message_count: number;
  reservation_id: string | null;
  inquiry_id: string | null;
  reservation_status: string | null;
  conversion_category: ConversionCategory | null;
  classification_confidence: number | null;
  classification_keywords: string | null; // JSON array
  raw_meta: string | null;                 // JSON
  manually_categorized: number;            // 0 | 1
  manual_note: string | null;
  linked_thread_id: string | null;         // cross-link to another thread (e.g. Gmail ↔ Meetreet)
  last_synced_at: string;
  created_at?: string;
}

export interface Message {
  id: string;
  thread_id: string;
  direction: MessageDirection;
  sent_at: string;
  from_name: string | null;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  body_html: string | null;
  source: MessageSource;
  raw_meta: string | null;
  created_at?: string;
}

export type NewMessageThread = Omit<MessageThread, 'created_at' | 'manually_categorized' | 'manual_note' | 'linked_thread_id'> & {
  // DB has DEFAULT 0 / NULL; sync jobs don't need to set these.
  manually_categorized?: number;
  manual_note?: string | null;
  linked_thread_id?: string | null;
};
export type NewMessage = Omit<Message, 'created_at'>;
