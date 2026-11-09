import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { listHostExampleCandidates } from './host-example-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

const SINCE = '2026-01-01T00:00:00Z';
const opts = (o: Partial<Parameters<typeof listHostExampleCandidates>[0]> = {}) =>
  ({ sinceIso: SINCE, limit: 50, ...o });

function seedThread(id: string, o: { listing?: string; source?: string; conv?: string | null } = {}) {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at, conversion_category)
    VALUES (?, ?, ?, 'airbnb', 'Anna', '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, '2026-09-19T10:00:00Z', ?)`)
    .run(id, o.listing ?? 'L1', o.source ?? 'hostex', o.conv ?? null);
}

function seedMsg(id: string, threadId: string, direction: 'inbound' | 'outbound', sentAt: string, body: string) {
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, ?, ?, ?, 'hostex')`)
    .run(id, threadId, direction, sentAt, body);
}

function seedDraft(id: string, threadId: string, o: {
  body?: string; status?: string; sentBy?: string | null; changed?: number | null; original?: string | null;
  createdAt?: string; sentAt?: string | null; cat?: string | null;
} = {}) {
  db.prepare(`INSERT INTO message_drafts (id, thread_id, provider, body, generated_by) VALUES (?, ?, 'hostex', ?, 'llm')`)
    .run(id, threadId, o.body ?? 'Hallo Anna');
  db.prepare(`UPDATE message_drafts SET status = ?, sent_by = ?, sent_body_changed = ?, original_body = ?,
      created_at = ?, sent_at = ?, auto_category = ? WHERE id = ?`)
    .run(o.status ?? 'sent', o.sentBy === undefined ? 'micha' : o.sentBy, o.changed ?? null, o.original ?? null,
      o.createdAt ?? '2026-09-19 11:00:00', o.sentAt === undefined ? '2026-09-19T11:05:00Z' : o.sentAt, o.cat ?? null, id);
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of [
    '014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql',
    '019_add_draft_model.sql', '020_add_feedback_and_suggestions.sql', '025_add_thread_discarded_at.sql',
    '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql',
    '031_add_judge_reasoning_and_release.sql', '032_add_draft_regeneration.sql', '039_add_draft_original_body.sql',
  ]) db.exec(mig(f));
  setDatabase(db);
  seedThread('t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('listHostExampleCandidates', () => {
  it('unchanged und changed enthalten; bei changed der gesendete Text, nicht original_body', () => {
    seedDraft('d1', 't1', { body: 'Unverändert' });
    seedThread('t2');
    seedDraft('d2', 't2', { body: 'Gesendet', changed: 1, original: 'Entwurf davor' });
    const rows = listHostExampleCandidates(opts());
    expect(rows.map(r => r.draftId).sort()).toEqual(['d1', 'd2']);
    expect(rows.find(r => r.draftId === 'd2')!.body).toBe('Gesendet');
  });

  it('auto-gesendete und nicht gesendete Drafts fliegen raus', () => {
    seedDraft('auto', 't1', { sentBy: 'auto' });
    seedDraft('disc', 't1', { status: 'discarded' });
    seedDraft('pend', 't1', { status: 'pending', sentBy: null, sentAt: null });
    seedDraft('err', 't1', { status: 'error' });
    seedDraft('send', 't1', { status: 'sending' });
    expect(listHostExampleCandidates(opts())).toEqual([]);
  });

  it('sent_by NULL (Altbestand) + sent → enthalten', () => {
    seedDraft('old', 't1', { sentBy: null });
    expect(listHostExampleCandidates(opts()).map(r => r.draftId)).toEqual(['old']);
  });

  it('leerer/Whitespace-Body fliegt raus', () => {
    seedDraft('empty', 't1', { body: '  \n ' });
    expect(listHostExampleCandidates(opts())).toEqual([]);
  });

  it('guestMessage = jüngste inbound vor created_at; outbound zählt nicht', () => {
    seedMsg('m1', 't1', 'inbound', '2026-09-19T08:00:00Z', 'ältere');
    seedMsg('m2', 't1', 'inbound', '2026-09-19T10:30:00Z', 'passende');
    seedMsg('m3', 't1', 'outbound', '2026-09-19T10:45:00Z', 'Host-Antwort');
    seedMsg('m4', 't1', 'inbound', '2026-09-19T12:00:00Z', 'spätere');
    seedDraft('d1', 't1', { createdAt: '2026-09-19 11:00:00' });
    expect(listHostExampleCandidates(opts())[0].guestMessage).toBe('passende');
  });

  it('ohne inbound → guestMessage null', () => {
    seedMsg('m1', 't1', 'outbound', '2026-09-19T10:00:00Z', 'nur Host');
    seedDraft('d1', 't1');
    expect(listHostExampleCandidates(opts())[0].guestMessage).toBeNull();
  });

  it('excludeThreadId, since, limit und Sortierung neueste zuerst', () => {
    seedThread('t2');
    seedDraft('old', 't1', { sentAt: '2025-06-01T10:00:00Z', createdAt: '2025-06-01 10:00:00' });
    seedDraft('a', 't1', { sentAt: '2026-03-01T10:00:00Z', createdAt: '2026-03-01 10:00:00' });
    seedDraft('b', 't1', { sentAt: '2026-05-01T10:00:00Z', createdAt: '2026-05-01 10:00:00' });
    seedDraft('c', 't2', { sentAt: '2026-04-01T10:00:00Z', createdAt: '2026-04-01 10:00:00' });
    expect(listHostExampleCandidates(opts()).map(r => r.draftId)).toEqual(['b', 'c', 'a']);
    expect(listHostExampleCandidates(opts({ limit: 2 })).map(r => r.draftId)).toEqual(['b', 'c']);
    expect(listHostExampleCandidates(opts({ excludeThreadId: 't1' })).map(r => r.draftId)).toEqual(['c']);
    expect(listHostExampleCandidates(opts({ excludeThreadId: null })).length).toBe(3);
  });

  it('reicht judgeCategory, conversionCategory, listingId, source, sentAt durch', () => {
    seedThread('t3', { listing: 'L9', source: 'guesty', conv: 'PRICE' });
    seedDraft('d1', 't3', { cat: 'dank_smalltalk' });
    const r = listHostExampleCandidates(opts())[0];
    expect(r).toMatchObject({
      draftId: 'd1', threadId: 't3', listingId: 'L9', source: 'guesty',
      judgeCategory: 'dank_smalltalk', conversionCategory: 'PRICE', sentAt: '2026-09-19T11:05:00Z',
    });
  });
});
