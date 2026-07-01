-- Migration: add model column to message_drafts
-- Created: 2026-07-01
--
-- Records which LLM produced an llm-generated draft (null for manual drafts).

ALTER TABLE message_drafts ADD COLUMN model TEXT;
