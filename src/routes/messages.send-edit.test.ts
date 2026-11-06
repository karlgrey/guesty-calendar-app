import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { MessageDraft } from '../types/messages.js';

// #1062: POST /drafts/:draftId/send mit geändertem Text sichert den Entwurfstext über
// saveEditedDraftBody (original_body); ohne Änderung kein Body-Update. Mock-Gerüst aus
// messages.reply.test.ts; sendClaimedDraft gemockt (Versand ist hier nicht Gegenstand).

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
const getDraftById = vi.fn();
const updateDraftBody = vi.fn();
const saveEditedDraftBody = vi.fn();
const setSentBodyChanged = vi.fn();
const sendClaimedDraft = vi.fn();
vi.mock('../services/draft-send-service.js', () => ({
  sendClaimedDraft: (...args: unknown[]) => sendClaimedDraft(...args),
}));
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: (...args: unknown[]) => createDraft(...args),
  getDraftById: (...args: unknown[]) => getDraftById(...args),
  getActiveDraftByThread: (...args: unknown[]) => getActiveDraftByThread(...args),
  markDraftSent: (...args: unknown[]) => markDraftSent(...args),
  markDraftError: (...args: unknown[]) => markDraftError(...args),
  discardDraft: vi.fn(),
  claimDraftForSending: (...args: unknown[]) => claimDraftForSending(...args),
  updateDraftBody: (...args: unknown[]) => updateDraftBody(...args),
  saveEditedDraftBody: (...args: unknown[]) => saveEditedDraftBody(...args),
  setSentBodyChanged: (...args: unknown[]) => setSentBodyChanged(...args),
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
// #699: neuer messages.ts-Import — dieser Testfile prüft nur POST .../reply, nicht
// GET /:threadId, daher komplett gemockt.
vi.mock('../services/stale-draft-regen.js', () => ({
  regenerateStaleDraftIfNeeded: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'test' }),
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

function draft(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    id: 'd1', thread_id: 'hostex:a', provider: 'hostex', body: 'x', status: 'pending',
    generated_by: 'manual', send_attempts: 0, external_message_id: null, error: null,
    created_at: '2026-08-17 09:00', sent_at: null, model: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getThreadById.mockReturnValue(hostexThread('hostex:a'));
  claimDraftForSending.mockReturnValue(true);
  sendClaimedDraft.mockResolvedValue({ ok: true });
});

async function send(text: string) {
  return fetch(`${base}/admin/messages/drafts/d1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: text }),
    redirect: 'manual',
  });
}

describe('POST /admin/messages/drafts/:draftId/send — original_body (#1062)', () => {
  it('geänderter Text → saveEditedDraftBody (sichert original_body), nicht updateDraftBody', async () => {
    getDraftById.mockReturnValue(draft({ body: 'Entwurf KI', generated_by: 'llm' }));
    const r = await send('Micha Fassung');
    expect(r.status).toBe(302);
    expect(saveEditedDraftBody).toHaveBeenCalledWith('d1', 'Micha Fassung');
    expect(updateDraftBody).not.toHaveBeenCalled();
    expect(setSentBodyChanged).toHaveBeenCalledWith('d1', true);
    expect(sendClaimedDraft).toHaveBeenCalledWith('d1', expect.anything(), 'Micha Fassung', 'micha');
  });

  it('unveränderter Text → kein Body-Update', async () => {
    getDraftById.mockReturnValue(draft({ body: 'Entwurf KI', generated_by: 'llm' }));
    await send('Entwurf KI');
    expect(saveEditedDraftBody).not.toHaveBeenCalled();
    expect(updateDraftBody).not.toHaveBeenCalled();
    expect(setSentBodyChanged).toHaveBeenCalledWith('d1', false);
  });

  // Browser-Textareas senden CRLF; der LLM-Entwurf liegt mit LF in der DB. Ohne Normalisierung
  // wäre jeder mehrzeilige Entwurf „geändert" (vor dem Fix: 54/54 Schattenfälle changed, alle mit \r).
  it('unveränderter mehrzeiliger Text mit CRLF aus der Textarea → kein Edit, Versand mit LF', async () => {
    getDraftById.mockReturnValue(draft({ body: 'Hallo Anna,\nCheck-in ab 15 Uhr.\nMicha', generated_by: 'llm' }));
    await send('Hallo Anna,\r\nCheck-in ab 15 Uhr.\r\nMicha');
    expect(saveEditedDraftBody).not.toHaveBeenCalled();
    expect(setSentBodyChanged).toHaveBeenCalledWith('d1', false);
    expect(sendClaimedDraft).toHaveBeenCalledWith('d1', expect.anything(), 'Hallo Anna,\nCheck-in ab 15 Uhr.\nMicha', 'micha');
  });

  it('geänderter Text mit CRLF → original_body gesichert, gespeichert und gesendet wird LF', async () => {
    getDraftById.mockReturnValue(draft({ body: 'Hallo Anna,\nCheck-in ab 15 Uhr.\nMicha', generated_by: 'llm' }));
    await send('Hallo Anna,\r\nCheck-in ab 16 Uhr.\r\nMicha');
    expect(saveEditedDraftBody).toHaveBeenCalledWith('d1', 'Hallo Anna,\nCheck-in ab 16 Uhr.\nMicha');
    expect(setSentBodyChanged).toHaveBeenCalledWith('d1', true);
    expect(sendClaimedDraft).toHaveBeenCalledWith('d1', expect.anything(), 'Hallo Anna,\nCheck-in ab 16 Uhr.\nMicha', 'micha');
  });
});
