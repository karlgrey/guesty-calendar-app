-- Migration: Unified message + thread storage across all sources (Guesty conversations + direct email)
-- Created: 2026-05-21
-- See docs/superpowers/specs/2026-05-21-messages-data-model.md
--
-- Goal: provider-agnostic conversation history that powers the conversion dashboard.
-- Threads collect related messages from any source (Guesty API conversations,
-- direct email IMAP label). Each thread is keyed by listing_id for multi-property
-- isolation, classified by drop-off reason at sync time (re-classifiable later).

CREATE TABLE message_threads (
  id TEXT PRIMARY KEY,                       -- e.g. 'guesty:6a0da3d894203b001268386a' or 'gmail:<thrid>'
  listing_id TEXT NOT NULL,
  source TEXT NOT NULL,                      -- 'guesty' | 'gmail'
  channel TEXT NOT NULL,                     -- 'airbnb' | 'booking.com' | 'vrbo' | 'direct_email' | 'manual' | ...
  guest_name TEXT,
  guest_email TEXT,                          -- nullable — Guesty rarely exposes, email always has it
  first_message_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,                       -- nullable: link to reservations.reservation_id when known
  inquiry_id TEXT,                           -- nullable: link to inquiries.inquiry_id
  reservation_status TEXT,                   -- 'confirmed' | 'inquiry' | 'declined' | 'canceled' | ...
  conversion_category TEXT,                  -- 'CONFIRMED' | 'PRICE' | 'WEDDING' | 'DIRECT_DRIFT' | 'OTHER' | NULL
  classification_confidence REAL,            -- 0.0 - 1.0
  classification_keywords TEXT,              -- JSON array of matched keywords
  raw_meta TEXT,                             -- JSON: source-specific extra fields
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_message_threads_listing ON message_threads(listing_id);
CREATE INDEX idx_message_threads_channel ON message_threads(channel);
CREATE INDEX idx_message_threads_last_msg ON message_threads(last_message_at);
CREATE INDEX idx_message_threads_category ON message_threads(conversion_category);
CREATE INDEX idx_message_threads_reservation ON message_threads(reservation_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,                       -- e.g. 'guesty:<postId>' or 'gmail:<messageId>'
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL,                   -- 'inbound' (guest → host) | 'outbound' (host → guest) | 'system' (log)
  sent_at TEXT NOT NULL,
  from_name TEXT,
  from_address TEXT,                         -- email if known
  to_address TEXT,                           -- mainly for email
  subject TEXT,                              -- email subject; nullable for Guesty posts
  body TEXT NOT NULL,                        -- normalized plain text
  body_html TEXT,                            -- nullable — kept for emails, NULL for Guesty
  source TEXT NOT NULL,                      -- 'guesty' | 'gmail'
  raw_meta TEXT,                             -- JSON: channel-specific extras
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);
CREATE INDEX idx_messages_direction ON messages(direction);

-- Per-property IMAP state for direct-email sync (analog to airbnb_mail_state).
CREATE TABLE direct_email_state (
  property_slug TEXT PRIMARY KEY,
  last_imap_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
);
