-- Migration: add message_drafts table
-- Created: 2026-07-01
--
-- Outbound reply drafts awaiting human approval. One 'pending' draft per thread
-- is the intended invariant (enforced in the repository/route layer, not the schema).

CREATE TABLE message_drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  provider TEXT NOT NULL,                       -- 'hostex' | 'guesty'
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'sent' | 'error' | 'discarded'
  generated_by TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'llm'
  send_attempts INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_drafts_thread ON message_drafts(thread_id, status);
