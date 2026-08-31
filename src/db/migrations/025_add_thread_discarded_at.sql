-- Migration: remember when a draft was manually discarded (Verwerfen), so
-- background draft generation (hourly ETL + "Jetzt syncen") doesn't immediately
-- redraft a thread the human deliberately left without a reply — SmartTasks #497
-- (Micha: discard usually has a reason, most often a time-sensitive draft, e.g.
-- "gute Heimreise", he didn't send in time; re-drafting it is pointless).
-- Same pattern as ai_no_reply_at (migration 021): the marker is only meaningful
-- while newer than last_message_at — a new guest message invalidates it
-- implicitly. Explicit user action (regenerate button / new manual draft) is
-- unaffected, since it bypasses getThreadsNeedingDraft entirely.
-- Created: 2026-08-31

ALTER TABLE message_threads ADD COLUMN discarded_at TEXT;
