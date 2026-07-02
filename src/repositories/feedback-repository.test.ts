// src/repositories/feedback-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createFeedback, createSuggestion, getSuggestionById, getPendingSuggestions,
  countPendingSuggestions, markSuggestionApplied, discardSuggestion,
} from './feedback-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE draft_feedback (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, draft_id TEXT, category TEXT NOT NULL,
      note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_suggestions (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, target_file TEXT NOT NULL,
      target_heading TEXT NOT NULL, addition_text TEXT NOT NULL, rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', applied_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT
    );
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seedSuggestion(id: string) {
  createFeedback({ id: `fb-${id}`, thread_id: 't1', draft_id: 'd1', category: 'ton', note: 'zu lang' });
  createSuggestion({ id, feedback_id: `fb-${id}`, target_file: 'Areas/Hosting/_Voice.md', target_heading: '## Anti-Pattern', addition_text: '- Regel', rationale: 'weil' });
}

describe('feedback-repository', () => {
  it('creates a suggestion and lists it as pending', () => {
    seedSuggestion('s1');
    expect(getSuggestionById('s1')?.status).toBe('pending');
    expect(getPendingSuggestions().map((s) => s.id)).toEqual(['s1']);
    expect(countPendingSuggestions()).toBe(1);
  });

  it('markSuggestionApplied moves it out of pending and records the commit', () => {
    seedSuggestion('s2');
    markSuggestionApplied('s2', 'abc123');
    expect(getPendingSuggestions()).toEqual([]);
    const s = getSuggestionById('s2');
    expect(s?.status).toBe('approved');
    expect(s?.applied_commit).toBe('abc123');
    expect(s?.applied_at).not.toBeNull();
  });

  it('discardSuggestion removes it from pending', () => {
    seedSuggestion('s3');
    discardSuggestion('s3');
    expect(getPendingSuggestions()).toEqual([]);
    expect(getSuggestionById('s3')?.status).toBe('discarded');
  });
});
