// #696: Zusagen-Task — Persistenz + Idempotenz-Lookup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, setSmartTasksTask, findExistingSmartTasksTaskId, getDraftById,
  setAutoDecision, getAwaitingDrafts,
} from './draft-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string, guest = 'Anna') {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, manually_categorized, last_synced_at)
    VALUES (?, 'L1', 'guesty', 'airbnb', ?, '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, 0, '2026-09-19T10:00:00Z')`).run(id, guest);
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, 'inbound', '2026-09-19T10:00:00Z', 'Danke!', 'guesty')`).run(`${id}:m1`, id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(mig('014_add_messages_threads.sql'));
  db.exec(mig('015_add_manual_category.sql'));
  db.exec(mig('018_add_message_drafts.sql'));
  db.exec(mig('019_add_draft_model.sql'));
  db.exec(mig('020_add_feedback_and_suggestions.sql'));
  db.exec(mig('025_add_thread_discarded_at.sql'));
  db.exec(mig('027_add_auto_send.sql'));
  db.exec(mig('029_add_smarttasks_task.sql'));
  setDatabase(db);
  seedThread('guesty:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('setSmartTasksTask / findExistingSmartTasksTaskId', () => {
  it('persistiert Task-Id + Gastnachrichten-Id am Draft', () => {
    createDraft({ id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setSmartTasksTask('d1', 742, 'guesty:t1:m1');
    const d = getDraftById('d1')!;
    expect(d.smarttasks_task_id).toBe(742);
    expect(d.smarttasks_task_guest_message_id).toBe('guesty:t1:m1');
  });

  it('findExistingSmartTasksTaskId: null ohne vorherigen Task', () => {
    expect(findExistingSmartTasksTaskId('guesty:t1', 'guesty:t1:m1')).toBeNull();
  });

  it('findet den Task eines VORHERIGEN Drafts für dieselbe Gastnachricht (Re-Generate/Sprach-Pin, Spec Punkt 6)', () => {
    createDraft({ id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'alt', generated_by: 'llm' });
    setSmartTasksTask('d1', 742, 'guesty:t1:m1');
    db.prepare(`UPDATE message_drafts SET status='discarded' WHERE id='d1'`).run(); // Sprach-Pin verwirft und regeneriert
    createDraft({ id: 'd2', thread_id: 'guesty:t1', provider: 'guesty', body: 'neu, korrigiert', generated_by: 'llm' });
    expect(findExistingSmartTasksTaskId('guesty:t1', 'guesty:t1:m1')).toBe(742);
  });

  it('ignoriert Tasks für eine ANDERE Gastnachricht im selben Thread', () => {
    createDraft({ id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setSmartTasksTask('d1', 742, 'guesty:t1:m1');
    expect(findExistingSmartTasksTaskId('guesty:t1', 'guesty:t1:m2-neue-nachricht')).toBeNull();
  });

  it('ignoriert Tasks aus einem ANDEREN Thread', () => {
    seedThread('guesty:t2', 'Ben');
    createDraft({ id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setSmartTasksTask('d1', 742, 'guesty:t1:m1');
    expect(findExistingSmartTasksTaskId('guesty:t2', 'guesty:t1:m1')).toBeNull();
  });
});

describe('getAwaitingDrafts liefert smarttasks_task_id mit', () => {
  it('null ohne Zusagen-Task', () => {
    createDraft({ id: 'w1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setAutoDecision('w1', { decision: 'wait', reason: 'Grund', category: 'geld', flags: [] }, 'live');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows[0].smarttasks_task_id).toBeNull();
  });

  it('Task-Id, wenn eine Zusage getrackt wurde, aber der Send danach hängt (Claim verloren, F3)', () => {
    createDraft({ id: 'stuck1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setSmartTasksTask('stuck1', 99, 'guesty:t1:m1');
    db.prepare(`UPDATE message_drafts SET auto_decision='auto', auto_mode='live', status='pending', auto_judged_at=datetime('now','-15 minutes') WHERE id='stuck1'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'stuck1');
    expect(row?.smarttasks_task_id).toBe(99);
  });
});
