import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { createDraft, setAutoDecision, listAutoDecisionCases } from './draft-repository.js';

// #1044: Einzelfälle des Auto-Send-Gates (Schattenphase auswerten)
let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string, guest = 'Anna') {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at)
    VALUES (?, 'L1', 'hostex', 'airbnb', ?, '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, '2026-09-19T10:00:00Z')`).run(id, guest);
}
function seedDraft(id: string, createdAt: string, decision: 'auto' | 'wait' | null) {
  createDraft({ id, thread_id: 'hostex:t1', provider: 'hostex', body: `Text ${id}`, generated_by: 'llm' });
  if (decision) setAutoDecision(id, { decision, reason: 'r', category: 'dank_smalltalk', flags: [] }, 'shadow');
  db.prepare(`UPDATE message_drafts SET created_at = ? WHERE id = ?`).run(createdAt, id);
}
function seedFeedback(id: string, draftId: string, category: string, note: string) {
  db.prepare(`INSERT INTO draft_feedback (id, thread_id, draft_id, category, note) VALUES (?, 'hostex:t1', ?, ?, ?)`).run(id, draftId, category, note);
}

const SINCE = '2026-10-01T00:00:00.000Z';

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql',
    '019_add_draft_model.sql', '020_add_feedback_and_suggestions.sql', '025_add_thread_discarded_at.sql',
    '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql',
    '031_add_judge_reasoning_and_release.sql']) db.exec(mig(m));
  setDatabase(db);
  seedThread('hostex:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('listAutoDecisionCases', () => {
  it('filtert Drafts außerhalb des Zeitfensters raus', () => {
    seedDraft('alt', '2026-09-01 10:00:00', 'auto');
    seedDraft('neu', '2026-10-05 10:00:00', 'auto');
    expect(listAutoDecisionCases(SINCE, null, 10).map((r) => r.id)).toEqual(['neu']);
  });

  it('lässt Drafts ohne auto_decision weg', () => {
    seedDraft('ohne', '2026-10-05 10:00:00', null);
    seedDraft('mit', '2026-10-05 11:00:00', 'wait');
    expect(listAutoDecisionCases(SINCE, null, 10).map((r) => r.id)).toEqual(['mit']);
  });

  it('decision-Filter auto / wait / null', () => {
    seedDraft('a', '2026-10-05 10:00:00', 'auto');
    seedDraft('w', '2026-10-05 11:00:00', 'wait');
    expect(listAutoDecisionCases(SINCE, 'auto', 10).map((r) => r.id)).toEqual(['a']);
    expect(listAutoDecisionCases(SINCE, 'wait', 10).map((r) => r.id)).toEqual(['w']);
    expect(listAutoDecisionCases(SINCE, null, 10).map((r) => r.id).sort()).toEqual(['a', 'w']);
  });

  it('liefert Thread-Felder und Feedback als JSON-Array', () => {
    seedDraft('f', '2026-10-05 10:00:00', 'auto');
    seedDraft('nofb', '2026-10-05 09:00:00', 'auto');
    seedFeedback('fb1', 'f', 'ton', 'zu förmlich');
    seedFeedback('fb2', 'f', 'fakt', 'Check-in ist 15 Uhr');
    const rows = listAutoDecisionCases(SINCE, null, 10);
    const f = rows.find((r) => r.id === 'f')!;
    expect(f.guest_name).toBe('Anna');
    expect(f.listing_id).toBe('L1');
    expect(f.source).toBe('hostex');
    const fb = JSON.parse(f.feedback_json) as Array<{ category: string; note: string; createdAt: string }>;
    expect(fb).toHaveLength(2);
    expect(fb.map((x) => x.category).sort()).toEqual(['fakt', 'ton']);
    expect(fb.find((x) => x.category === 'ton')!.note).toBe('zu förmlich');
    expect(rows.find((r) => r.id === 'nofb')!.feedback_json).toBe('[]');
  });

  it('sortiert neueste zuerst und begrenzt per limit', () => {
    seedDraft('d1', '2026-10-05 10:00:00', 'auto');
    seedDraft('d2', '2026-10-06 10:00:00', 'auto');
    seedDraft('d3', '2026-10-07 10:00:00', 'auto');
    expect(listAutoDecisionCases(SINCE, null, 10).map((r) => r.id)).toEqual(['d3', 'd2', 'd1']);
    expect(listAutoDecisionCases(SINCE, null, 2).map((r) => r.id)).toEqual(['d3', 'd2']);
  });
});
