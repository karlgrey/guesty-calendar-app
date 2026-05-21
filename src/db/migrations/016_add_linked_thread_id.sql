-- Migration: cross-link message threads (e.g. Gmail thread ↔ Meetreet Guesty thread)
-- Created: 2026-05-21
--
-- For Meetreet inquiries, the booking metadata lives in a Guesty conversation
-- (channel='meetreet', placeholder messages with company name in guest_name)
-- while the actual host-guest correspondence — if any — happens via direct
-- email (Gmail label). Linking the two surfaces the full lead in the dashboard.

ALTER TABLE message_threads ADD COLUMN linked_thread_id TEXT;
CREATE INDEX idx_message_threads_linked ON message_threads(linked_thread_id);
