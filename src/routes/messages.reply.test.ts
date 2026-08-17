import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { MessageDraft } from '../types/messages.js';

// Direktes Senden ohne Zwei-Schritt-Freigabe (SmartTasks #409, Nachschärfung):
// POST /:threadId/reply legt einen manuellen Draft an und schickt ihn sofort über
// denselben Send-Pfad wie POST /drafts/:draftId/send. Gemockt wird nur, was diese
// Route tatsächlich anfasst — Muster aus messages.view-alle.test.ts.

const getThreadById = vi.fn();
const getMessagesByThread = vi.fn();
const upsertMessage = vi.fn();
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: vi.fn().mockReturnValue([]),
  getThreadById: (...args: unknown[]) => getThreadById(...args),
  getMessagesByThread: (...args: unknown[]) => getMessagesByThread(...args),
  upsertMessage: (...args: unknown[]) => upsertMessage(...args),
  getLastMessageSync: vi.fn().mockReturnValue(null),
  markThreadAiNoReply: vi.fn(),
  getThreadsNeedingDraft: vi.fn().mockReturnValue([]),
  getMessagesSince: vi.fn().mockReturnValue([]),
}));

const createDraft = vi.fn();
const getActiveDraftByThread = vi.fn();
const claimDraftForSending = vi.fn();
const markDraftSent = vi.fn();
const markDraftError = vi.fn();
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: (...args: unknown[]) => createDraft(...args),
  getDraftById: vi.fn(),
  getActiveDraftByThread: (...args: unknown[]) => getActiveDraftByThread(...args),
  markDraftSent: (...args: unknown[]) => markDraftSent(...args),
  markDraftError: (...args: unknown[]) => markDraftError(...args),
  discardDraft: vi.fn(),
  claimDraftForSending: (...args: unknown[]) => claimDraftForSending(...args),
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

const sendReply = vi.fn();
vi.mock('../services/message-sender.js', () => ({
  sendReply: (...args: unknown[]) => sendReply(...args),
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

function hostexThread(id: string) {
  return {
    id, listing_id: 'L1', source: 'hostex' as const, channel: 'airbnb' as const,
    guest_name: 'Anna', guest_email: null, first_message_at: '', last_message_at: '2026-08-17 09:00',
    message_count: 1, reservation_id: null, inquiry_id: null, reservation_status: null,
    conversion_category: null, classification_confidence: null, classification_keywords: null,
    classification_reasoning: null, raw_meta: null, manually_categorized: 0, manual_note: null,
    linked_thread_id: null, ai_no_reply_at: null, last_synced_at: '',
  };
}

function guestyThread(id: string) {
  return { ...hostexThread(id), source: 'guesty' as const };
}

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

describe('POST /admin/messages/:threadId/reply (Direkt-Senden ohne Freigabe-Schritt)', () => {
  it('Erfolgspfad: legt manuellen Draft an, sendet ihn sofort, redirectet mit ?sent=1', async () => {
    getThreadById.mockReturnValue(hostexThread('hostex:a'));
    getMessagesByThread.mockReturnValue([]);
    getActiveDraftByThread.mockReturnValue(null);
    claimDraftForSending.mockReturnValue(true);
    sendReply.mockResolvedValue({ externalMessageId: 'ext-1' });

    const r = await fetch(`${base}/admin/messages/hostex%3Aa/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'Hallo Anna, klar!' }),
      redirect: 'manual',
    });

    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/messages/hostex%3Aa?sent=1');
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: 'hostex:a', provider: 'hostex', body: 'Hallo Anna, klar!', generated_by: 'manual',
    }));
    expect(claimDraftForSending).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(markDraftSent).toHaveBeenCalledTimes(1);
    expect(upsertMessage).toHaveBeenCalledTimes(1);
    expect(upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'outbound', body: 'Hallo Anna, klar!', thread_id: 'hostex:a',
    }));
  });

  it('leerer Body -> 400, kein Draft angelegt', async () => {
    getThreadById.mockReturnValue(hostexThread('hostex:a'));

    const r = await fetch(`${base}/admin/messages/hostex%3Aa/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: '   ' }),
      redirect: 'manual',
    });

    expect(r.status).toBe(400);
    expect(createDraft).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('unbekannter Thread -> 404', async () => {
    getThreadById.mockReturnValue(null);

    const r = await fetch(`${base}/admin/messages/hostex%3Aunknown/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'Hallo' }),
      redirect: 'manual',
    });

    expect(r.status).toBe(404);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('vorhandener aktiver Entwurf -> Redirect ?draftexists=1, kein neuer Draft', async () => {
    getThreadById.mockReturnValue(hostexThread('hostex:a'));
    getMessagesByThread.mockReturnValue([]);
    getActiveDraftByThread.mockReturnValue(draft());

    const r = await fetch(`${base}/admin/messages/hostex%3Aa/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'Hallo Anna' }),
      redirect: 'manual',
    });

    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/messages/hostex%3Aa?draftexists=1');
    expect(createDraft).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('canSend=false (Guesty, Kanal nicht auflösbar) -> Redirect ?sendblocked=1, kein Sendeversuch', async () => {
    getThreadById.mockReturnValue(guestyThread('guesty:a'));
    getMessagesByThread.mockReturnValue([]); // kein Inbound -> resolveOutboundModuleType => null
    getActiveDraftByThread.mockReturnValue(null);

    const r = await fetch(`${base}/admin/messages/guesty%3Aa/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'Hallo' }),
      redirect: 'manual',
    });

    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/messages/guesty%3Aa?sendblocked=1');
    expect(createDraft).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });
});
