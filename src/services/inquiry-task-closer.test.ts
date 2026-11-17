// #1210: Inquiry-Task schließt sich selbst, sobald die Antwort gesendet ist.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { closeAnsweredInquiryTasks, buildClosureComment, type InquiryTaskCloserDeps } from './inquiry-task-closer.js';
import {
  findAnsweredInquiryTasks, claimInquiryTaskClosure, finishInquiryTaskClosure,
  releaseInquiryTaskClosure, releaseStaleInquiryTaskClaims,
} from '../repositories/inquiry-task-closure-repository.js';
import { ExternalApiError } from '../utils/errors.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');
const BASE_MIGRATIONS = ['014_add_messages_threads.sql', '018_add_message_drafts.sql', '019_add_draft_model.sql',
  '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql'];

function thread(id: string) {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at)
    VALUES (?, 'L1', 'guesty', 'airbnb', 'Anna', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', 1, '2026-11-01T10:00:00Z')`).run(id);
}
function msg(id: string, threadId: string, direction: string, sentAt: string, body = 'x') {
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, ?, ?, ?, 'guesty')`)
    .run(id, threadId, direction, sentAt, body);
}
function draft(id: string, threadId: string, kind: 'inquiry' | 'request_to_book', taskId: number, systemMsgId: string) {
  db.prepare(`INSERT INTO message_drafts (id, thread_id, provider, body, generated_by, request_kind, smarttasks_task_id, smarttasks_task_guest_message_id)
    VALUES (?, ?, 'guesty', 'Entwurf', 'llm', ?, ?, ?)`).run(id, threadId, kind, taskId, systemMsgId);
}
/** Inquiry-Thread: Gastnachricht 10:00, System-Post 10:00:06, Task am Draft. */
function inquiryThread(threadId: string, taskId: number, kind: 'inquiry' | 'request_to_book' = 'inquiry') {
  thread(threadId);
  msg(`${threadId}:g1`, threadId, 'inbound', '2026-11-16T10:00:00Z', 'Is it free?');
  msg(`${threadId}:sys`, threadId, 'system', '2026-11-16T10:00:06Z', kind === 'inquiry' ? 'New guest inquiry' : 'New guest reservation request HMXYZ');
  draft(`${threadId}:d1`, threadId, kind, taskId, `${threadId}:sys`);
}

function client(status = 'To Do') {
  return {
    getTask: vi.fn(async (id: number) => ({ id, status })),
    updateTaskStatus: vi.fn(async () => undefined),
    addComment: vi.fn(async () => undefined),
  };
}
function deps(c: ReturnType<typeof client>): InquiryTaskCloserDeps {
  return {
    getClient: () => c, findAnswered: findAnsweredInquiryTasks, claim: claimInquiryTaskClosure,
    finish: finishInquiryTaskClosure, release: releaseInquiryTaskClosure, releaseStale: releaseStaleInquiryTaskClaims,
  };
}
const outcome = (taskId: number) =>
  (db.prepare('SELECT outcome FROM inquiry_task_closures WHERE task_id = ?').get(taskId) as { outcome: string } | undefined)?.outcome;

beforeEach(() => {
  db = new Database(':memory:');
  for (const m of BASE_MIGRATIONS) db.exec(mig(m));
  db.exec(mig('042_add_inquiry_task_closures.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('closeAnsweredInquiryTasks (#1210)', () => {
  it('Inquiry wartend mit Task: nach Versand Done plus Kommentar', async () => {
    inquiryThread('guesty:t1', 501);
    msg('guesty:o1', 'guesty:t1', 'outbound', '2026-11-16T11:30:00.000Z', 'Hallo Anna');
    const c = client();
    const r = await closeAnsweredInquiryTasks({}, deps(c));
    expect(r).toEqual({ closed: 1, skipped: 0, failed: 0 });
    expect(c.updateTaskStatus).toHaveBeenCalledWith(501, 'Done');
    expect(c.addComment).toHaveBeenCalledWith(501, buildClosureComment('2026-11-16T11:30:00.000Z'));
    expect(buildClosureComment('2026-11-16T11:30:00.000Z')).toBe('Antwort gesendet 16.11. 12:30, Task automatisch geschlossen');
    expect(outcome(501)).toBe('closed');
  });

  it('Antwort direkt in Airbnb (per Sync gesehene Host-Nachricht) schließt ebenfalls', async () => {
    inquiryThread('guesty:t2', 502);
    // Sync-Zeile (Guesty-Post-Id), kein draft-send-service — derselbe Pfad über messages.
    msg('guesty:post-host-1', 'guesty:t2', 'outbound', '2026-11-16T13:00:00Z', 'Hi from Airbnb app');
    const c = client();
    await closeAnsweredInquiryTasks({ threadId: 'guesty:t2' }, deps(c));
    expect(c.updateTaskStatus).toHaveBeenCalledWith(502, 'Done');
    expect(c.addComment).toHaveBeenCalledTimes(1);
  });

  it('noch keine Antwort (Host-Nachricht nur VOR dem System-Post): Task bleibt offen', async () => {
    thread('guesty:t3');
    msg('guesty:o0', 'guesty:t3', 'outbound', '2026-11-15T09:00:00Z', 'alte Nachricht');
    msg('guesty:t3:g1', 'guesty:t3', 'inbound', '2026-11-16T10:00:00Z');
    msg('guesty:t3:sys', 'guesty:t3', 'system', '2026-11-16T10:00:06Z', 'New guest inquiry');
    draft('guesty:t3:d1', 'guesty:t3', 'inquiry', 503, 'guesty:t3:sys');
    const c = client();
    const r = await closeAnsweredInquiryTasks({}, deps(c));
    expect(r.closed).toBe(0);
    expect(c.getTask).not.toHaveBeenCalled();
  });

  it('Request-to-Book bleibt offen, auch nach gesendeter Antwort', async () => {
    inquiryThread('guesty:t4', 504, 'request_to_book');
    msg('guesty:o4', 'guesty:t4', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    await closeAnsweredInquiryTasks({}, deps(c));
    expect(c.getTask).not.toHaveBeenCalled();
    expect(c.updateTaskStatus).not.toHaveBeenCalled();
    expect(outcome(504)).toBeUndefined();
  });

  it('zweiter Sync: kein zweites Schließen, kein zweiter Kommentar (auch bei mehreren Drafts je Task)', async () => {
    inquiryThread('guesty:t5', 505);
    draft('guesty:t5:d2', 'guesty:t5', 'inquiry', 505, 'guesty:t5:sys'); // Folge-Draft, Task wiederverwendet
    msg('guesty:o5', 'guesty:t5', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    await closeAnsweredInquiryTasks({}, deps(c));
    await closeAnsweredInquiryTasks({}, deps(c));
    msg('guesty:o5b', 'guesty:t5', 'outbound', '2026-11-16T12:00:00Z'); // weitere Antwort
    await closeAnsweredInquiryTasks({}, deps(c));
    expect(c.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(c.addComment).toHaveBeenCalledTimes(1);
  });

  it('parallele Läufe schließen/kommentieren nur einmal', async () => {
    inquiryThread('guesty:t6', 506);
    msg('guesty:o6', 'guesty:t6', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    await Promise.all([closeAnsweredInquiryTasks({}, deps(c)), closeAnsweredInquiryTasks({ threadId: 'guesty:t6' }, deps(c))]);
    expect(c.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(c.addComment).toHaveBeenCalledTimes(1);
  });

  it('von Hand geschlossener oder verworfener Task wird nicht angefasst', async () => {
    inquiryThread('guesty:t7', 507);
    msg('guesty:o7', 'guesty:t7', 'outbound', '2026-11-16T11:00:00Z');
    inquiryThread('guesty:t8', 508);
    msg('guesty:o8', 'guesty:t8', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    c.getTask.mockImplementation(async (id: number) => ({ id, status: id === 507 ? 'Done' : 'Dropped' }));
    const r = await closeAnsweredInquiryTasks({}, deps(c));
    expect(r).toEqual({ closed: 0, skipped: 2, failed: 0 });
    expect(c.updateTaskStatus).not.toHaveBeenCalled();
    expect(c.addComment).not.toHaveBeenCalled();
    expect(outcome(507)).toBe('skipped');
  });

  it('API-Ausfall: wirft nicht, nächster Sync versucht erneut', async () => {
    inquiryThread('guesty:t9', 509);
    msg('guesty:o9', 'guesty:t9', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    c.getTask.mockRejectedValueOnce(new ExternalApiError('SmartTasks-Aufruf fehlgeschlagen (Timeout)', 0, 'SmartTasks'));
    const r1 = await closeAnsweredInquiryTasks({}, deps(c));
    expect(r1).toEqual({ closed: 0, skipped: 0, failed: 1 });
    expect(outcome(509)).toBeUndefined();
    const r2 = await closeAnsweredInquiryTasks({}, deps(c));
    expect(r2.closed).toBe(1);
  });

  it('fehlender API-Key (Client-Konstruktion wirft): kein Abbruch', async () => {
    inquiryThread('guesty:t10', 510);
    msg('guesty:o10', 'guesty:t10', 'outbound', '2026-11-16T11:00:00Z');
    const d = deps(client());
    d.getClient = () => { throw new Error('SMARTTASKS_API_KEY is required'); };
    await expect(closeAnsweredInquiryTasks({}, d)).resolves.toEqual({ closed: 0, skipped: 0, failed: 1 });
  });

  it('dauerhafter Fehler (403) wird verbucht, kein Dauer-Retry', async () => {
    inquiryThread('guesty:t11', 511);
    msg('guesty:o11', 'guesty:t11', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    c.updateTaskStatus.mockRejectedValue(new ExternalApiError('SmartTasks HTTP 403', 403, 'SmartTasks'));
    await closeAnsweredInquiryTasks({}, deps(c));
    await closeAnsweredInquiryTasks({}, deps(c));
    expect(c.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(outcome(511)).toBe('skipped');
  });

  it('Kommentar-Fehler: Task bleibt geschlossen, kein Doppelkommentar beim nächsten Sync', async () => {
    inquiryThread('guesty:t12', 512);
    msg('guesty:o12', 'guesty:t12', 'outbound', '2026-11-16T11:00:00Z');
    const c = client();
    c.addComment.mockRejectedValueOnce(new Error('boom'));
    await closeAnsweredInquiryTasks({}, deps(c));
    await closeAnsweredInquiryTasks({}, deps(c));
    expect(c.addComment).toHaveBeenCalledTimes(1);
    expect(outcome(512)).toBe('closed');
  });
});

describe('Migration 042: bestehende Inquiry-Tasks bleiben unangetastet (Tabu)', () => {
  it('vor der Migration angelegte Inquiry-Tasks werden als legacy verbucht und nie geschlossen', async () => {
    const legacy = new Database(':memory:');
    for (const m of BASE_MIGRATIONS) legacy.exec(mig(m));
    resetDatabase();
    db.close();
    db = legacy;
    setDatabase(db);
    inquiryThread('guesty:old', 400);
    msg('guesty:o-old', 'guesty:old', 'outbound', '2026-11-16T11:00:00Z');
    inquiryThread('guesty:rtb', 401, 'request_to_book');
    db.exec(mig('042_add_inquiry_task_closures.sql'));
    expect(outcome(400)).toBe('legacy');
    expect(outcome(401)).toBeUndefined();
    const c = client();
    await closeAnsweredInquiryTasks({}, deps(c));
    expect(c.getTask).not.toHaveBeenCalled();
  });
});
