// src/repositories/feedback-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createFeedback, createSuggestion, getSuggestionById, getPendingSuggestions,
  countPendingSuggestions, markSuggestionApplied, discardSuggestion,
  getSuggestionsByStatus, markSuggestionRevoked,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT,
      revoked_at TEXT, revoke_commit TEXT
    );
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seedSuggestion(id: string) {
  createFeedback({ id: `fb-${id}`, thread_id: 't1', draft_id: 'd1', category: 'ton', note: 'zu lang' });
  createSuggestion({ id, feedback_id: `fb-${id}`, target_file: 'prozesse/Gästekommunikation Grundsätze.md', target_heading: '## Anti-Pattern', addition_text: '- Regel', rationale: 'weil' });
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

  it('markSuggestionRevoked setzt status/revoked_at/revoke_commit; Re-Approve räumt sie wieder', () => {
    seedSuggestion('s4');
    markSuggestionApplied('s4', 'aaa');
    markSuggestionRevoked('s4', 'bbb');
    let s = getSuggestionById('s4');
    expect(s?.status).toBe('revoked');
    expect(s?.revoke_commit).toBe('bbb');
    expect(s?.revoked_at).not.toBeNull();
    expect(getSuggestionsByStatus('revoked').map((x) => x.id)).toEqual(['s4']);
    expect(getSuggestionsByStatus('approved')).toEqual([]);
    markSuggestionApplied('s4', 'ccc');
    s = getSuggestionById('s4');
    expect(s?.status).toBe('approved');
    expect(s?.revoked_at).toBeNull();
    expect(s?.revoke_commit).toBeNull();
    expect(getSuggestionsByStatus('approved').map((x) => x.id)).toEqual(['s4']);
  });
});
