import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { MessageDraft, MessageThread } from '../types/messages.js';

// GET /admin/messages/:threadId ruft VOR dem Rendern regenerateStaleDraftIfNeeded auf (#699) —
// dieser Test prüft nur die Route-Seite (Warnhinweis + Vorversions-Details im HTML), nicht die
// Service-Logik selbst (siehe stale-draft-regen.test.ts). Muster wie messages.discard.test.ts.

const getThreadById = vi.fn();
const getMessagesByThread = vi.fn();
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: vi.fn().mockReturnValue([]),
  getThreadById: (...args: unknown[]) => getThreadById(...args),
  getMessagesByThread: (...args: unknown[]) => getMessagesByThread(...args),
  upsertMessage: vi.fn(),
  getLastMessageSync: vi.fn().mockReturnValue(null),
  markThreadAiNoReply: vi.fn(),
  markThreadDiscarded: vi.fn(),
  getThreadsNeedingDraft: vi.fn().mockReturnValue([]),
  getMessagesSince: vi.fn().mockReturnValue([]),
}));

const getActiveDraftByThread = vi.fn();
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: vi.fn(),
  getDraftById: vi.fn(),
  getActiveDraftByThread: (...args: unknown[]) => getActiveDraftByThread(...args),
  discardDraft: vi.fn(),
  claimDraftForSending: vi.fn(),
  updateDraftBody: vi.fn(),
  markDraftSent: vi.fn(),
  markDraftError: vi.fn(),
  setSentBodyChanged: vi.fn(),
  getAutoSendStats: vi.fn(),
  countAutoSentSince: vi.fn().mockReturnValue(0),
  listAutoDecisions: vi.fn().mockReturnValue([]),
  getLastSentDraftByThread: vi.fn().mockReturnValue(null),
  threadHasFailedSend: vi.fn().mockReturnValue(false),
  releaseAutoSendForThread: vi.fn(),
}));

vi.mock('../repositories/feedback-repository.js', () => ({
  createFeedback: vi.fn(),
  createSuggestion: vi.fn(),
  countPendingSuggestions: vi.fn().mockReturnValue(0),
}));
vi.mock('../utils/thread-property.js', () => ({
  getPropertyForThread: vi.fn().mockReturnValue(undefined),
  propertyForBadge: vi.fn().mockReturnValue(undefined),
}));

const regenerateStaleDraftIfNeeded = vi.fn();
vi.mock('../services/stale-draft-regen.js', () => ({
  regenerateStaleDraftIfNeeded: (...args: unknown[]) => regenerateStaleDraftIfNeeded(...args),
}));

import messagesRoutes from './messages.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/admin/messages', messagesRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

function thread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 'guesty:a', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Anna', guest_email: null,
    first_message_at: '', last_message_at: '2026-09-25 10:00:00', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '',
    ...over,
  };
}

function draft(over: Partial<MessageDraft> = {}): MessageDraft {
  return {
    id: 'd1', thread_id: 'guesty:a', provider: 'guesty', body: 'Entwurfstext', status: 'pending',
    generated_by: 'llm', send_attempts: 0, external_message_id: null, error: null,
    created_at: '2026-09-25 04:00:00', sent_at: null, model: 'claude-sonnet-5',
    auto_decision: null, auto_category: null, auto_flags: null, auto_reason: null, auto_mode: null,
    auto_judged_at: null, sent_by: null, sent_body_changed: null,
    smarttasks_task_id: null, smarttasks_task_guest_message_id: null,
    request_kind: null, platform_deadline_at: null,
    regenerated_at: null, regen_attempted_at: null, previous_body: null, previous_body_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMessagesByThread.mockReturnValue([]);
});

describe('GET /admin/messages/:threadId — Stale-Draft-Regeneration', () => {
  it('ruft regenerateStaleDraftIfNeeded auf und zeigt bei fehlgeschlagener Regeneration weiter den Warnhinweis (10h alter Entwurf, Default 6h)', async () => {
    getThreadById.mockReturnValue(thread());
    regenerateStaleDraftIfNeeded.mockResolvedValue({ kind: 'failed', reason: 'Vault-Wissen fehlt' });
    getActiveDraftByThread.mockReturnValue(draft({ created_at: '2026-09-25 04:00:00' }));

    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
    expect(regenerateStaleDraftIfNeeded).toHaveBeenCalledTimes(1);
    const html = await r.text();
    expect(html).toContain('Zeitbezüge prüfen');
  });

  it('kein Warnhinweis, wenn der Entwurf frisch ist (regenerated_at gerade eben)', async () => {
    getThreadById.mockReturnValue(thread());
    regenerateStaleDraftIfNeeded.mockResolvedValue({ kind: 'regenerated' });
    getActiveDraftByThread.mockReturnValue(draft({ regenerated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }));

    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain('Zeitbezüge prüfen');
  });

  it('zeigt die Vorversion aufklappbar an, wenn previous_body gesetzt ist', async () => {
    getThreadById.mockReturnValue(thread());
    regenerateStaleDraftIfNeeded.mockResolvedValue({ kind: 'regenerated' });
    getActiveDraftByThread.mockReturnValue(draft({
      body: 'neuer Text nach Regeneration',
      previous_body: 'alter Text vor Regeneration',
      previous_body_at: '2026-09-25 04:00:00',
      regenerated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    }));

    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Vorversion');
    expect(html).toContain('alter Text vor Regeneration');
  });

  it('ohne previous_body keine Vorversions-Details', async () => {
    getThreadById.mockReturnValue(thread());
    regenerateStaleDraftIfNeeded.mockResolvedValue({ kind: 'fresh' });
    getActiveDraftByThread.mockReturnValue(draft());

    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    const html = await r.text();
    expect(html).not.toContain('Vorversion');
  });

  it('wirft die Service-Funktion, rendert die Seite trotzdem (200), nur ein Log-Warn', async () => {
    getThreadById.mockReturnValue(thread());
    regenerateStaleDraftIfNeeded.mockRejectedValue(new Error('kaputt'));
    getActiveDraftByThread.mockReturnValue(draft());

    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
  });

  it('unbekannter Thread -> 404, Service wird nicht aufgerufen', async () => {
    getThreadById.mockReturnValue(null);
    const r = await fetch(`${base}/admin/messages/unknown`);
    expect(r.status).toBe(404);
    expect(regenerateStaleDraftIfNeeded).not.toHaveBeenCalled();
  });
});
