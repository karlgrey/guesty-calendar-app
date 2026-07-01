import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { createDraft, getDraftById, updateDraftBody } from './draft-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_drafts (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    generated_by TEXT NOT NULL DEFAULT 'manual', send_attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT, model TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('draft-repository model + updateDraftBody', () => {
  it('stores model on llm drafts and null when omitted', () => {
    createDraft({ id: 'd1', thread_id: 't1', provider: 'hostex', body: 'x', generated_by: 'llm', model: 'claude-sonnet-4-6' });
    createDraft({ id: 'd2', thread_id: 't2', provider: 'hostex', body: 'y', generated_by: 'manual' });
    expect(getDraftById('d1')?.model).toBe('claude-sonnet-4-6');
    expect(getDraftById('d2')?.model).toBeNull();
  });

  it('updateDraftBody replaces the body', () => {
    createDraft({ id: 'd3', thread_id: 't3', provider: 'hostex', body: 'old', generated_by: 'llm', model: 'm' });
    updateDraftBody('d3', 'new');
    expect(getDraftById('d3')?.body).toBe('new');
  });
});
