// src/repositories/feedback-repository.origin.test.ts
// #1295: Migration 046 (feedback_id nullable, Spalte origin) gegen echte Migrationen 020 + 038 + 046.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createFeedback, createSuggestion, createOriginSuggestion, getSuggestionById,
  getSuggestionsByStatus, discardSuggestion, markSuggestionApplied,
} from './feedback-repository.js';

const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('020_add_feedback_and_suggestions.sql'));
  db.exec(mig('038_add_vault_suggestion_revoke.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const REL = 'prozesse/Gästekommunikation Grundsätze.md';

describe('Migration 046 (#1295)', () => {
  it('Bestandsvorschläge behalten Daten, Reihenfolge und bekommen origin = feedback', () => {
    createFeedback({ id: 'fb1', thread_id: 't1', draft_id: null, category: 'ton', note: 'n' });
    createSuggestion({ id: 'b', feedback_id: 'fb1', target_file: REL, target_heading: '## A', addition_text: '- b', rationale: 'r' });
    createSuggestion({ id: 'a', feedback_id: 'fb1', target_file: REL, target_heading: '## A', addition_text: '- a', rationale: 'r' });
    markSuggestionApplied('a', 'sha1');
    db.exec(mig('046_vault_suggestion_origin.sql'));

    const a = getSuggestionById('a')!;
    expect(a.origin).toBe('feedback');
    expect(a.feedback_id).toBe('fb1');
    expect(a.status).toBe('approved');
    expect(a.applied_commit).toBe('sha1');
    expect(getSuggestionById('b')!.origin).toBe('feedback');
    // rowid übernommen: Tiebreaker der Sortierung bleibt stabil
    const rowids = db.prepare('SELECT id, rowid AS r FROM vault_suggestions ORDER BY rowid').all() as { id: string }[];
    expect(rowids.map((x) => x.id)).toEqual(['b', 'a']);
    // Index wieder da
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vault_suggestions'`).all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain('idx_vault_suggestions_status');
  });

  it('verwaiste feedback_id (FK war aus) bricht den Rebuild nicht ab, wird NULL', () => {
    db.pragma('foreign_keys = OFF');
    createSuggestion({ id: 'w', feedback_id: 'weg', target_file: REL, target_heading: '## A', addition_text: '- w', rationale: 'r' });
    db.pragma('foreign_keys = ON');
    db.transaction(() => db.exec(mig('046_vault_suggestion_origin.sql')))();
    expect(getSuggestionById('w')).toMatchObject({ feedback_id: null, origin: 'feedback', status: 'pending' });
  });

  it('feedback_id ist nullable, FK + CASCADE auf draft_feedback bleiben', () => {
    db.exec(mig('046_vault_suggestion_origin.sql'));
    createFeedback({ id: 'fb1', thread_id: 't1', draft_id: null, category: 'fakt', note: 'n' });
    createSuggestion({ id: 'f', feedback_id: 'fb1', target_file: REL, target_heading: '## A', addition_text: '- f', rationale: 'r' });
    createOriginSuggestion({ id: 'o', target_file: REL, target_heading: '## A', addition_text: '- o', rationale: 'r', origin: 'diff-auswertung' });

    expect(() => createSuggestion({ id: 'x', feedback_id: 'gibt-es-nicht', target_file: REL, target_heading: '## A', addition_text: '- x', rationale: 'r' }))
      .toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM draft_feedback WHERE id = ?').run('fb1');
    expect(getSuggestionById('f')).toBeNull();
    expect(getSuggestionById('o')).not.toBeNull();
  });
});

describe('createOriginSuggestion (#1295)', () => {
  beforeEach(() => { db.exec(mig('046_vault_suggestion_origin.sql')); });

  it('legt pending ohne feedback_id mit Herkunft an und erscheint unter Offen', () => {
    createOriginSuggestion({ id: 'o1', target_file: REL, target_heading: '## Anti-Pattern', addition_text: '- Leerzeile', rationale: 'KW 47', origin: 'diff-auswertung' });
    const s = getSuggestionById('o1')!;
    expect(s).toMatchObject({ status: 'pending', feedback_id: null, origin: 'diff-auswertung', target_file: REL, applied_commit: null });
    expect(getSuggestionsByStatus('pending').map((x) => x.id)).toEqual(['o1']);
  });

  it('Feedback-Vorschläge bekommen weiter origin = feedback (DB-Default)', () => {
    createFeedback({ id: 'fb', thread_id: 't', draft_id: null, category: 'ton', note: 'n' });
    createSuggestion({ id: 's', feedback_id: 'fb', target_file: REL, target_heading: '## A', addition_text: '- s', rationale: 'r' });
    expect(getSuggestionById('s')!.origin).toBe('feedback');
  });

  it('Verwerfen funktioniert ohne feedback_id', () => {
    createOriginSuggestion({ id: 'o2', target_file: REL, target_heading: '## A', addition_text: '- x', rationale: 'r', origin: 'diff-auswertung' });
    expect(discardSuggestion('o2')).toBe(true);
    expect(getSuggestionById('o2')!.status).toBe('discarded');
  });
});
