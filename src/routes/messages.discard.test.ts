import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { MessageDraft } from '../types/messages.js';

// Verwerfen soll verwerfen: der Thread bleibt draftlos, bis entweder eine neue
// Gastnachricht ankommt oder Micha explizit "Neu generieren" klickt — SmartTasks
// #497. Root-Cause war NICHT der Discard-Handler selbst (der stößt nie eine
// Generierung an), sondern getThreadsNeedingDraft im nächsten Cron-/Sync-Lauf,
// die einen draftlosen Thread nicht von einem bewusst verworfenen unterscheiden
// konnte. Fix: discard markiert den Thread zusätzlich per markThreadDiscarded
// (Muster wie markThreadAiNoReply) — dieser Test prüft nur die Route-Seite
// (dass der Marker beim Discard gesetzt wird); die Query-Seite ist in
// message-repository.needs-draft.test.ts abgedeckt.

const markThreadDiscarded = vi.fn();
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: vi.fn().mockReturnValue([]),
  getThreadById: vi.fn(),
  getMessagesByThread: vi.fn().mockReturnValue([]),
  upsertMessage: vi.fn(),
  getLastMessageSync: vi.fn().mockReturnValue(null),
  markThreadAiNoReply: vi.fn(),
  markThreadDiscarded: (...args: unknown[]) => markThreadDiscarded(...args),
  getThreadsNeedingDraft: vi.fn().mockReturnValue([]),
  getMessagesSince: vi.fn().mockReturnValue([]),
}));

const getDraftById = vi.fn();
const discardDraft = vi.fn();
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: vi.fn(),
  getDraftById: (...args: unknown[]) => getDraftById(...args),
  getActiveDraftByThread: vi.fn(),
  markDraftSent: vi.fn(),
  markDraftError: vi.fn(),
  discardDraft: (...args: unknown[]) => discardDraft(...args),
  claimDraftForSending: vi.fn(),
  updateDraftBody: vi.fn(),
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
vi.mock('../services/message-sender.js', () => ({
  sendReply: vi.fn(),
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

function draft(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    id: 'd1', thread_id: 'hostex:a', provider: 'hostex', body: 'x', status: 'pending',
    generated_by: 'manual', send_attempts: 0, external_message_id: null, error: null,
    created_at: '2026-08-17 09:00', sent_at: null, model: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/messages/drafts/:draftId/discard', () => {
  it('verwirft den Draft UND markiert den Thread als discarded (kein Auto-Redraft mehr)', async () => {
    getDraftById.mockReturnValue(draft({ id: 'd1', thread_id: 'hostex:a' }));

    const r = await fetch(`${base}/admin/messages/drafts/d1/discard`, {
      method: 'POST',
      redirect: 'manual',
    });

    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/messages/hostex%3Aa');
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(discardDraft).toHaveBeenCalledWith('d1');
    expect(markThreadDiscarded).toHaveBeenCalledTimes(1);
    expect(markThreadDiscarded).toHaveBeenCalledWith('hostex:a');
  });

  it('unbekannter Draft -> 404, kein Marker gesetzt', async () => {
    getDraftById.mockReturnValue(null);

    const r = await fetch(`${base}/admin/messages/drafts/unknown/discard`, {
      method: 'POST',
      redirect: 'manual',
    });

    expect(r.status).toBe(404);
    expect(discardDraft).not.toHaveBeenCalled();
    expect(markThreadDiscarded).not.toHaveBeenCalled();
  });
});
