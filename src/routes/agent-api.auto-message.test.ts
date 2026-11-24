// #1298 Regressionstest: Hostex' automatische Check-in-Nachricht (direction 'system')
// darf eine offene Gastfrage weder in /threads noch im Thread-Detail verdecken.
// Echte Route, echte In-Memory-DB mit den Produktions-Migrationen.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: {
      ...mod.config,
      agentApiKey: 'test-agent-key-0123456789abcdef0123456789',
      agentApiKeySet: ['test-agent-key-0123456789abcdef0123456789'],
    },
  };
});
vi.mock('../utils/thread-property.js', () => ({
  propertyForBadge: () => ({ slug: 'testhaus', name: 'Testhaus', shortCode: 'TH' }),
  getPropertyForThread: () => undefined,
}));

import { setDatabase, resetDatabase } from '../db/index.js';
import { upsertThread, upsertMessage, getThreadsNeedingReply } from '../repositories/message-repository.js';
import { mapHostexConversation } from '../mappers/hostex/message-mapper.js';
import type { HostexConversationDetail } from '../services/hostex-client.js';
import agentApiRoutes from './agent-api.js';

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789' };
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

const AUTO_TEXT =
  'Hallo Anna, dein Aufenthalt findet bald statt. Du kannst am 20. Nov. 2026 ab 15:00 jederzeit einchecken.\n\n' +
  'Hier ist die Adresse: Musterstraße 1, 12345 Musterstadt. Hier sind die WLAN-Zugangsdaten: Name: Test, Passwort: xxx.\n\n' +
  'Wenn du Fragen hast, gib mir gern Bescheid. Ich wünsche dir einen schönen Aufenthalt.';

let db: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql',
    '019_add_draft_model.sql', '021_add_ai_no_reply.sql', '025_add_thread_discarded_at.sql',
    '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql',
    '031_add_judge_reasoning_and_release.sql', '032_add_draft_regeneration.sql', '039_add_draft_original_body.sql']) {
    db.exec(mig(m));
  }
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function thread(id: string, lastMessageAt: string) {
  upsertThread({
    id, listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'Anna', guest_email: null,
    first_message_at: '2026-11-18T14:53:00Z', last_message_at: lastMessageAt, message_count: 2,
    reservation_id: null, inquiry_id: null, reservation_status: null,
    conversion_category: null, classification_confidence: null, classification_keywords: null,
    raw_meta: null, last_synced_at: '2026-11-19T09:05:00Z',
  } as Parameters<typeof upsertThread>[0]);
}

function msg(id: string, threadId: string, direction: 'inbound' | 'outbound' | 'system', sentAt: string, body: string, rawMeta: string | null = null) {
  upsertMessage({
    id, thread_id: threadId, direction, sent_at: sentAt,
    from_name: direction === 'inbound' ? 'Anna' : 'host', from_address: null, to_address: null,
    subject: null, body, body_html: null, source: 'hostex', raw_meta: rawMeta,
  });
}

const AUTO_META = JSON.stringify({ sender_role: 'host', automatic: true });

async function listThread(id: string) {
  const r = await fetch(`${base}/api/agent/threads?since=2026-11-01T00:00:00Z`, { headers: KEY });
  expect(r.status).toBe(200);
  return (await r.json()).threads.find((t: any) => t.threadId === id);
}
async function detail(id: string) {
  const r = await fetch(`${base}/api/agent/threads/${encodeURIComponent(id)}`, { headers: KEY });
  expect(r.status).toBe(200);
  return r.json();
}

describe('agent-api #1298 automatische Hostex-Nachricht verdeckt keine Gastfrage', () => {
  it('Gastfrage + automatische system-Nachricht -> needsReply true; nach echter Antwort false', async () => {
    thread('hostex:fall-1298', '2026-11-19T09:00:16Z');
    msg('m1', 'hostex:fall-1298', 'inbound', '2026-11-18T14:53:00Z', 'Hallo, könnten wir am 20. schon früher einchecken?');
    msg('m2', 'hostex:fall-1298', 'system', '2026-11-19T09:00:16Z', AUTO_TEXT, AUTO_META);
    db.prepare(`INSERT INTO message_drafts (id, thread_id, provider, body, status, created_at)
      VALUES ('d1','hostex:fall-1298','hostex','Entwurf','pending','2026-11-18 15:10:00')`).run();

    const listed = await listThread('hostex:fall-1298');
    expect(listed).toMatchObject({
      needsReply: true, lastMessageDirection: 'inbound', pendingDraftSince: '2026-11-18T15:10:00.000Z',
    });

    const d = await detail('hostex:fall-1298');
    expect(d.needsReply).toBe(true);
    expect(d.messages.map((m: any) => m.direction)).toEqual(['inbound', 'system']);
    expect(d.messages[1].body).toBe(AUTO_TEXT);

    expect(getThreadsNeedingReply('-3650 days').map((t) => t.id)).toContain('hostex:fall-1298');

    // Echte Antwort des Hosts
    msg('m3', 'hostex:fall-1298', 'outbound', '2026-11-20T06:17:00Z', 'Hey Anna, früher einchecken ab 14:00 Uhr ist in der Regel kein Problem.');
    thread('hostex:fall-1298', '2026-11-20T06:17:00Z');

    expect((await listThread('hostex:fall-1298'))).toMatchObject({ needsReply: false, lastMessageDirection: 'outbound' });
    const d2 = await detail('hostex:fall-1298');
    expect(d2.needsReply).toBe(false);
    expect(d2.messages.map((m: any) => m.direction)).toEqual(['inbound', 'system', 'outbound']);
  });

  it('ohne pending-Entwurf -> pendingDraftSince null', async () => {
    thread('hostex:nodraft', '2026-11-19T09:00:16Z');
    msg('n1', 'hostex:nodraft', 'inbound', '2026-11-18T14:53:00Z', 'Frage');
    msg('n2', 'hostex:nodraft', 'system', '2026-11-19T09:00:16Z', AUTO_TEXT, AUTO_META);
    db.prepare(`INSERT INTO message_drafts (id, thread_id, provider, body, status, created_at)
      VALUES ('d2','hostex:nodraft','hostex','alt','discarded','2026-11-18 15:10:00')`).run();

    expect(await listThread('hostex:nodraft')).toMatchObject({ needsReply: true, pendingDraftSince: null });
  });

  it('Kette Hostex-Mapper -> DB -> Route: Altzeile outbound wird beim erneuten Sync zu system', async () => {
    const detailRaw = {
      id: '0-test-1298', channel_type: 'airbnb', guest: { name: 'Anna' }, property_title: 'Testhaus',
      messages: [
        { id: 'h1', sender_role: 'guest', display_type: 'Text', content: 'Hallo, könnten wir am 20. schon früher einchecken?', created_at: '2026-11-18T14:53:00+00:00', sender_name: null, sources: [] },
        { id: 'h2', sender_role: 'host', display_type: 'Text', content: AUTO_TEXT, created_at: '2026-11-19T09:00:16+00:00', sender_name: 'host@example.com', sources: [] },
      ],
    } as unknown as HostexConversationDetail;
    const { thread: t, messages } = mapHostexConversation(detailRaw, 'L1', '2026-11-19T09:05:00Z');
    upsertThread(t!);
    // Altbestand vor #1298: dieselbe Nachricht lag als outbound in der DB.
    upsertMessage({ ...messages[1], direction: 'outbound', raw_meta: JSON.stringify({ sender_role: 'host' }) });
    upsertMessage(messages[0]);
    expect((await listThread('hostex:0-test-1298')).needsReply).toBe(false);

    // Erneuter Sync mit dem neuen Mapper überschreibt direction (upsertMessage ON CONFLICT).
    for (const m of messages) upsertMessage(m);
    expect((await listThread('hostex:0-test-1298')).needsReply).toBe(true);
    const d = await detail('hostex:0-test-1298');
    expect(d.needsReply).toBe(true);
    expect(d.messages.map((m: any) => m.direction)).toEqual(['inbound', 'system']);
    const row = db.prepare(`SELECT raw_meta FROM messages WHERE id = 'hostex:h2'`).get() as { raw_meta: string };
    expect(JSON.parse(row.raw_meta)).toEqual({ sender_role: 'host', sender_name: 'host@example.com', sources: [], automatic: true });
  });
});
