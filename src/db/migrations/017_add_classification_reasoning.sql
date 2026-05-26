-- Migration 017: add classification_reasoning column for LLM-based classifier.
-- The LLM emits a one-sentence reasoning alongside category + confidence,
-- replacing the regex-era classification_keywords transparency channel.
-- The classification_keywords column is intentionally kept to preserve
-- historical regex classifications until they are re-classified.

ALTER TABLE message_threads ADD COLUMN classification_reasoning TEXT;
