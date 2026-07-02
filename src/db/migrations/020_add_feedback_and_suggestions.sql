-- Migration: draft feedback + vault suggestions (Schnitt 3 feedback loop)
-- Created: 2026-07-02

CREATE TABLE draft_feedback (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  draft_id TEXT,
  category TEXT NOT NULL,            -- 'ton' | 'fakt' | 'einmalig'
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_suggestions (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  target_file TEXT NOT NULL,
  target_heading TEXT NOT NULL,
  addition_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'discarded'
  applied_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  FOREIGN KEY (feedback_id) REFERENCES draft_feedback(id) ON DELETE CASCADE
);

CREATE INDEX idx_vault_suggestions_status ON vault_suggestions(status);
