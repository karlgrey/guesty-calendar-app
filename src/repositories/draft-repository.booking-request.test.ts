// #697: Buchungsanfrage — Persistenz (request_kind/platform_deadline_at) + Sichtbarkeit in
// getAwaitingDrafts (Push/Task auch bei auto_decision='auto', live gesendet ODER Schatten).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, setBookingRequestContext, getDraftById, setAutoDecision, markDraftSent, getAwaitingDrafts,
} from './draft-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string, guest = 'Anika') {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, manually_categorized, last_synced_at)
    VALUES (?, 'L1', 'guesty', 'airbnb', ?, '2026-09-21T10:00:00Z', '2026-09-21T10:00:00Z', 1, 0, '2026-09-21T10:00:00Z')`).run(id, guest);
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, 'inbound', '2026-09-21T20:34:58Z', 'Event-Anfrage', 'guesty')`).run(`${id}:m1`, id);
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
  db.exec(mig('030_add_booking_request.sql'));
  db.exec(mig('031_add_judge_reasoning_and_release.sql'));
  setDatabase(db);
  seedThread('guesty:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('setBookingRequestContext', () => {
  it('persistiert request_kind + platform_deadline_at am Draft', () => {
    createDraft({ id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setBookingRequestContext('d1', 'request_to_book', '2026-09-22T20:35:04.000Z');
    const d = getDraftById('d1')!;
    expect(d.request_kind).toBe('request_to_book');
    expect(d.platform_deadline_at).toBe('2026-09-22T20:35:04.000Z');
  });
  it('ohne Aufruf bleiben beide Felder NULL', () => {
    createDraft({ id: 'd2', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    const d = getDraftById('d2')!;
    expect(d.request_kind).toBeNull();
    expect(d.platform_deadline_at).toBeNull();
  });
});

describe('getAwaitingDrafts: Buchungsanfrage erscheint immer bei auto_decision=auto', () => {
  it('live gesendet (status=sent) → enthalten mit eigenem Grund', () => {
    createDraft({ id: 'ba1', thread_id: 'guesty:t1', provider: 'guesty', body: 'Rückfrage', generated_by: 'llm' });
    setBookingRequestContext('ba1', 'request_to_book', '2026-09-22T20:35:04.000Z');
    setAutoDecision('ba1', { decision: 'auto', reason: 'Buchungsanfrage: …', category: 'buchungsanfrage', flags: [] }, 'live');
    markDraftSent('ba1', 'ext-1', 'auto');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'ba1');
    expect(row).toBeDefined();
    expect(row!.reason).toBe('Rückfrage automatisch gesendet — Entscheidung in Airbnb nach Gast-Antwort');
    expect(row!.request_kind).toBe('request_to_book');
    expect(row!.platform_deadline_at).toBe('2026-09-22T20:35:04.000Z');
  });

  it('Schattenmodus (auto, nicht gesendet, pending) → enthalten mit Schatten-Grund', () => {
    createDraft({ id: 'ba2', thread_id: 'guesty:t1', provider: 'guesty', body: 'Rückfrage', generated_by: 'llm' });
    setBookingRequestContext('ba2', 'inquiry', '2026-09-22T09:00:00.000Z');
    setAutoDecision('ba2', { decision: 'auto', reason: 'Buchungsanfrage: …', category: 'buchungsanfrage', flags: [] }, 'shadow');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'ba2');
    expect(row).toBeDefined();
    expect(row!.reason).toBe('Rückfrage wäre automatisch gesendet worden (Schatten) — Entscheidung in Airbnb nach Gast-Antwort');
    expect(row!.auto_mode).toBe('shadow');
  });

  it('wait-Entscheidung nutzt weiter den normalen auto_reason-Pfad', () => {
    createDraft({ id: 'ba3', thread_id: 'guesty:t1', provider: 'guesty', body: 'Rückfrage', generated_by: 'llm' });
    setBookingRequestContext('ba3', 'request_to_book', '2026-09-22T20:35:04.000Z');
    setAutoDecision('ba3', { decision: 'wait', reason: 'Task konnte nicht angelegt werden', category: 'buchungsanfrage', flags: [] }, 'live');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'ba3');
    expect(row!.reason).toBe('Task konnte nicht angelegt werden');
  });

  it('andere Kategorien mit auto_decision=auto, status=sent bleiben unsichtbar (unverändertes Verhalten)', () => {
    createDraft({ id: 'ok1', thread_id: 'guesty:t1', provider: 'guesty', body: 'x', generated_by: 'llm' });
    setAutoDecision('ok1', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'live');
    markDraftSent('ok1', 'ext-2', 'auto');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.find((r) => r.id === 'ok1')).toBeUndefined();
  });
});
