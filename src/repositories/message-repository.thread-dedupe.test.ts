import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getMessagesByThread } from './message-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL,
      from_name TEXT, from_address TEXT, to_address TEXT, subject TEXT, body TEXT NOT NULL, body_html TEXT,
      source TEXT NOT NULL, raw_meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getMessagesByThread Echo-Dedupe (#974)', () => {
  it('liefert Sende-Zeile + Echo als eine Nachricht, DB bleibt unverändert', () => {
    const ins = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source,raw_meta) VALUES (?,?,?,?,?,?,?)`);
    ins.run('hostex:e1', 'hostex:t1', 'outbound', '2026-10-26T09:44:23+00:00', 'Hallo\r\nGast A', 'hostex', '{"sender_role":"host"}');
    ins.run('sent:d1', 'hostex:t1', 'outbound', '2026-10-26T09:44:24.155Z', 'Hallo\nGast A', 'hostex', '{"draftId":"d1","externalMessageId":"","sentBy":"micha"}');
    const out = getMessagesByThread('hostex:t1');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('hostex:e1');
    expect(out[0].sent_at).toBe('2026-10-26T09:44:24.155Z');
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(2);
  });
});
