import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase, executeSchema, runMigrations } from '../db/index.js';
import { createDraft, getDraftById, saveEditedDraftBody, updateDraftBody, setAutoDecision, listAutoDecisionCases } from './draft-repository.js';

// #1062: original_body = Entwurfstext vor dem ersten Edit (Migration 039)
let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql',
    '019_add_draft_model.sql', '020_add_feedback_and_suggestions.sql', '025_add_thread_discarded_at.sql',
    '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql',
    '031_add_judge_reasoning_and_release.sql', '032_add_draft_regeneration.sql', '039_add_draft_original_body.sql']) db.exec(mig(m));
  setDatabase(db);
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at)
    VALUES ('hostex:t1', 'L1', 'hostex', 'airbnb', 'Anna', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', 1, '2026-11-01T10:00:00Z')`).run();
  createDraft({ id: 'd1', thread_id: 'hostex:t1', provider: 'hostex', body: 'Entwurf KI', generated_by: 'llm' });
});
afterEach(() => { resetDatabase(); db.close(); });

describe('saveEditedDraftBody', () => {
  it('neuer Draft hat original_body NULL', () => {
    expect(getDraftById('d1')!.original_body).toBeNull();
  });

  it('erster Edit sichert den bisherigen body in original_body', () => {
    saveEditedDraftBody('d1', 'Micha Fassung 1');
    const d = getDraftById('d1')!;
    expect(d.body).toBe('Micha Fassung 1');
    expect(d.original_body).toBe('Entwurf KI');
  });

  it('spätere Edits lassen original_body stehen', () => {
    saveEditedDraftBody('d1', 'Micha Fassung 1');
    saveEditedDraftBody('d1', 'Micha Fassung 2');
    const d = getDraftById('d1')!;
    expect(d.body).toBe('Micha Fassung 2');
    expect(d.original_body).toBe('Entwurf KI');
  });

  it('updateDraftBody (Sprach-Neuversuch der Generierung) setzt original_body NICHT', () => {
    updateDraftBody('d1', 'Neuversuch KI');
    const d = getDraftById('d1')!;
    expect(d.body).toBe('Neuversuch KI');
    expect(d.original_body).toBeNull();
    // der danach bearbeitete Ausgangstext ist der Neuversuch, nicht die erste Fassung
    saveEditedDraftBody('d1', 'Micha');
    expect(getDraftById('d1')!.original_body).toBe('Neuversuch KI');
  });

  it('listAutoDecisionCases liefert original_body mit', () => {
    setAutoDecision('d1', { decision: 'auto', reason: 'r', category: 'dank_smalltalk', flags: [] }, 'shadow');
    saveEditedDraftBody('d1', 'Micha');
    const [row] = listAutoDecisionCases('2000-01-01T00:00:00.000Z', null, 10);
    expect(row.original_body).toBe('Entwurf KI');
    expect(row.body).toBe('Micha');
  });
});

describe('Migration 039 im Runner', () => {
  it('runMigrations legt message_drafts.original_body an', () => {
    const d = new Database(':memory:');
    setDatabase(d);
    executeSchema();
    runMigrations();
    const cols = (d.prepare('PRAGMA table_info(message_drafts)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('original_body');
    d.close();
  });
});
