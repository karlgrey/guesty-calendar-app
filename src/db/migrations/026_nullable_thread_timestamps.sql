-- Migration: message_threads.first_message_at/last_message_at nullable
-- Created: 2026-09-10
-- SmartTasks #577-Nachfix
--
-- Hostex legt für JEDE Reservierung/Anfrage eine Conversation an, auch wenn sie
-- NIE eine einzige Nachricht enthält (weder Text noch System-Karte wie 'Box'/
-- 'ReservationAlteration') — verifiziert live gegen die Hostex-API für
-- hostex:0-2660304253 ("Julie Winkel"): DETAIL liefert `messages: []` und kein
-- eigenes Zeitfeld. Der Mapper (message-mapper.ts) nutzt dafür seit diesem Fix
-- ersatzweise das last_message_at aus der Hostex LIST-Antwort — liefert Hostex
-- auch DAS nicht, bleibt der Zeitstempel NULL statt (wie bisher) auf den
-- Sync-Zeitpunkt `now` zu fallen, was solche Threads bei jedem nächtlichen Sync
-- erneut als "gerade aktiv" erscheinen ließ (SmartTasks #577).
--
-- first_message_at/last_message_at waren NOT NULL (Migration 014) — SQLite kennt
-- kein `ALTER TABLE … ALTER COLUMN … DROP NOT NULL`, daher der volle Table-Rebuild
-- (12-Step-Prozedur der SQLite-Doku). Alle anderen Quellen (Guesty, direct-email)
-- liefern weiterhin immer echte Zeitstempel — für sie ändert sich nichts.

CREATE TABLE message_threads_new (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  guest_name TEXT,
  guest_email TEXT,
  first_message_at TEXT,                     -- NULLABLE seit #577-Nachfix (war NOT NULL)
  last_message_at TEXT,                      -- NULLABLE seit #577-Nachfix (war NOT NULL)
  message_count INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,
  inquiry_id TEXT,
  reservation_status TEXT,
  conversion_category TEXT,
  classification_confidence REAL,
  classification_keywords TEXT,
  raw_meta TEXT,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  manually_categorized INTEGER NOT NULL DEFAULT 0,
  manual_note TEXT,
  linked_thread_id TEXT,
  classification_reasoning TEXT,
  ai_no_reply_at TEXT,
  discarded_at TEXT
);

INSERT INTO message_threads_new (
  id, listing_id, source, channel, guest_name, guest_email,
  first_message_at, last_message_at, message_count,
  reservation_id, inquiry_id, reservation_status,
  conversion_category, classification_confidence, classification_keywords,
  raw_meta, last_synced_at, created_at,
  manually_categorized, manual_note, linked_thread_id, classification_reasoning,
  ai_no_reply_at, discarded_at
)
SELECT
  id, listing_id, source, channel, guest_name, guest_email,
  first_message_at, last_message_at, message_count,
  reservation_id, inquiry_id, reservation_status,
  conversion_category, classification_confidence, classification_keywords,
  raw_meta, last_synced_at, created_at,
  manually_categorized, manual_note, linked_thread_id, classification_reasoning,
  ai_no_reply_at, discarded_at
FROM message_threads;

DROP TABLE message_threads;
ALTER TABLE message_threads_new RENAME TO message_threads;

CREATE INDEX idx_message_threads_listing ON message_threads(listing_id);
CREATE INDEX idx_message_threads_channel ON message_threads(channel);
CREATE INDEX idx_message_threads_last_msg ON message_threads(last_message_at);
CREATE INDEX idx_message_threads_category ON message_threads(conversion_category);
CREATE INDEX idx_message_threads_reservation ON message_threads(reservation_id);
CREATE INDEX idx_message_threads_linked ON message_threads(linked_thread_id);
