-- Migration: remember when the LLM decided a thread needs no reply.
-- Set by draft generation (cron + regenerate button) when the model returns an
-- empty reply. A thread is "no reply needed" as long as ai_no_reply_at is newer
-- than last_message_at; a new guest message invalidates the marker implicitly.
-- Created: 2026-07-07

ALTER TABLE message_threads ADD COLUMN ai_no_reply_at TEXT;
