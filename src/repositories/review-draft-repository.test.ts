// src/repositories/review-draft-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createReviewDraft, getReviewDraftById, hasReviewDraftForReservation, getOpenReviewDrafts,
  markReviewDraftDone, discardReviewDraft, updateReviewDraftBody, setReviewDraftContent,
} from './review-draft-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE review_drafts (
    id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, listing_id TEXT NOT NULL, provider TEXT NOT NULL,
    guest_name TEXT, check_out TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    body TEXT, flag_reason TEXT, generated_by TEXT NOT NULL DEFAULT 'llm', model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('review-draft-repository', () => {
  it('creates and reads a pending review draft', () => {
    createReviewDraft({
      id: 'r1', reservation_id: 'res1', listing_id: 'L1', provider: 'guesty',
      guest_name: 'Darleen', check_out: '2026-08-05', status: 'pending', body: 'Toller Gast!', generated_by: 'llm',
    });
    const d = getReviewDraftById('r1');
    expect(d?.status).toBe('pending');
    expect(d?.body).toBe('Toller Gast!');
    expect(d?.flag_reason).toBeNull();
    expect(hasReviewDraftForReservation('res1')).toBe(true);
    expect(hasReviewDraftForReservation('does-not-exist')).toBe(false);
  });

  it('creates a needs_review draft with a flag_reason and no body', () => {
    createReviewDraft({
      id: 'r2', reservation_id: 'res2', listing_id: 'L1', provider: 'hostex',
      guest_name: 'Problematic Guest', check_out: '2026-08-06', status: 'needs_review',
      flag_reason: 'Beschwerde über Heizung.', generated_by: 'llm',
    });
    const d = getReviewDraftById('r2');
    expect(d?.status).toBe('needs_review');
    expect(d?.body).toBeNull();
    expect(d?.flag_reason).toBe('Beschwerde über Heizung.');
  });

  it('getOpenReviewDrafts returns pending + needs_review, newest checkout first, excludes done/discarded', () => {
    createReviewDraft({ id: 'a', reservation_id: 'ra', listing_id: 'L1', provider: 'guesty', guest_name: 'A', check_out: '2026-08-01', status: 'pending', body: 'x', generated_by: 'llm' });
    createReviewDraft({ id: 'b', reservation_id: 'rb', listing_id: 'L1', provider: 'guesty', guest_name: 'B', check_out: '2026-08-03', status: 'needs_review', flag_reason: 'y', generated_by: 'llm' });
    createReviewDraft({ id: 'c', reservation_id: 'rc', listing_id: 'L1', provider: 'guesty', guest_name: 'C', check_out: '2026-08-02', status: 'done', body: 'z', generated_by: 'llm' });
    const open = getOpenReviewDrafts();
    expect(open.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('markReviewDraftDone sets status/done_at and optionally overwrites body', () => {
    createReviewDraft({ id: 'r3', reservation_id: 'res3', listing_id: 'L1', provider: 'guesty', guest_name: 'X', check_out: '2026-08-05', status: 'pending', body: 'orig', generated_by: 'llm' });
    markReviewDraftDone('r3', 'edited text');
    const d = getReviewDraftById('r3');
    expect(d?.status).toBe('done');
    expect(d?.body).toBe('edited text');
    expect(d?.done_at).not.toBeNull();
  });

  it('markReviewDraftDone keeps the existing body when passed null', () => {
    createReviewDraft({ id: 'r4', reservation_id: 'res4', listing_id: 'L1', provider: 'guesty', guest_name: 'X', check_out: '2026-08-05', status: 'pending', body: 'orig', generated_by: 'llm' });
    markReviewDraftDone('r4', null);
    expect(getReviewDraftById('r4')?.body).toBe('orig');
  });

  it('discardReviewDraft sets status to discarded', () => {
    createReviewDraft({ id: 'r5', reservation_id: 'res5', listing_id: 'L1', provider: 'guesty', guest_name: 'X', check_out: '2026-08-05', status: 'pending', body: 'x', generated_by: 'llm' });
    discardReviewDraft('r5');
    expect(getReviewDraftById('r5')?.status).toBe('discarded');
  });

  it('updateReviewDraftBody overwrites the body only', () => {
    createReviewDraft({ id: 'r6', reservation_id: 'res6', listing_id: 'L1', provider: 'guesty', guest_name: 'X', check_out: '2026-08-05', status: 'pending', body: 'orig', generated_by: 'llm' });
    updateReviewDraftBody('r6', 'new text');
    const d = getReviewDraftById('r6');
    expect(d?.body).toBe('new text');
    expect(d?.status).toBe('pending');
  });

  it('setReviewDraftContent switches a needs_review draft into pending with fresh content', () => {
    createReviewDraft({ id: 'r7', reservation_id: 'res7', listing_id: 'L1', provider: 'guesty', guest_name: 'X', check_out: '2026-08-05', status: 'needs_review', flag_reason: 'old reason', generated_by: 'llm' });
    setReviewDraftContent('r7', { status: 'pending', body: 'regenerated', flag_reason: null, model: 'claude-sonnet-5' });
    const d = getReviewDraftById('r7');
    expect(d?.status).toBe('pending');
    expect(d?.body).toBe('regenerated');
    expect(d?.flag_reason).toBeNull();
    expect(d?.model).toBe('claude-sonnet-5');
  });
});
