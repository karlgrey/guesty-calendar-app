// src/repositories/draft-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, getDraftById, getActiveDraftByThread,
  markDraftSent, markDraftError, discardDraft, claimDraftForSending,
} from './draft-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_drafts (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    generated_by TEXT NOT NULL DEFAULT 'manual', send_attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, model TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('draft-repository', () => {
  it('creates and reads a pending draft', () => {
    createDraft({ id: 'd1', thread_id: 'hostex:c1', provider: 'hostex', body: 'Hallo', generated_by: 'manual' });
    const d = getDraftById('d1');
    expect(d?.status).toBe('pending');
    expect(d?.body).toBe('Hallo');
    expect(getActiveDraftByThread('hostex:c1')?.id).toBe('d1');
  });

  it('markDraftSent moves draft out of active and records external id', () => {
    createDraft({ id: 'd2', thread_id: 'hostex:c2', provider: 'hostex', body: 'x', generated_by: 'manual' });
    markDraftSent('d2', 'ext-99');
    expect(getActiveDraftByThread('hostex:c2')).toBeNull();
    const d = getDraftById('d2');
    expect(d?.status).toBe('sent');
    expect(d?.external_message_id).toBe('ext-99');
    expect(d?.sent_at).not.toBeNull();
  });

  it('markDraftError increments attempts and keeps error text', () => {
    createDraft({ id: 'd3', thread_id: 'hostex:c3', provider: 'hostex', body: 'x', generated_by: 'manual' });
    markDraftError('d3', 'boom');
    const d = getDraftById('d3');
    expect(d?.status).toBe('error');
    expect(d?.send_attempts).toBe(1);
    expect(d?.error).toBe('boom');
  });

  it('discardDraft removes it from active', () => {
    createDraft({ id: 'd4', thread_id: 'hostex:c4', provider: 'hostex', body: 'x', generated_by: 'manual' });
    discardDraft('d4');
    expect(getActiveDraftByThread('hostex:c4')).toBeNull();
    expect(getDraftById('d4')?.status).toBe('discarded');
  });

  describe('claimDraftForSending', () => {
    it('returns true and sets status=sending on first call for a pending draft', () => {
      createDraft({ id: 'd5', thread_id: 'hostex:c5', provider: 'hostex', body: 'x', generated_by: 'manual' });
      const claimed = claimDraftForSending('d5');
      expect(claimed).toBe(true);
      expect(getDraftById('d5')?.status).toBe('sending');
    });

    it('returns false on a second call (draft no longer pending)', () => {
      createDraft({ id: 'd6', thread_id: 'hostex:c6', provider: 'hostex', body: 'x', generated_by: 'manual' });
      claimDraftForSending('d6');
      const secondClaim = claimDraftForSending('d6');
      expect(secondClaim).toBe(false);
    });

    it('returns false for a non-existent draft id', () => {
      const result = claimDraftForSending('does-not-exist');
      expect(result).toBe(false);
    });
  });
});
