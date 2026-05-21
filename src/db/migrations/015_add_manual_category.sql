-- Migration: manual category override on message_threads
-- Created: 2026-05-21
--
-- When the user knows the real drop-off reason for a thread (e.g. "buchte
-- per Telefon", "Datum war besetzt", "Geschenk-Voucher"), they can override
-- the auto-classification via the conversion dashboard. The override survives
-- subsequent syncs + re-classifier runs.

ALTER TABLE message_threads ADD COLUMN manually_categorized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_threads ADD COLUMN manual_note TEXT;
