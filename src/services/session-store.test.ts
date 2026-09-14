/**
 * Tests für den SQLite-basierten Session-Store (persistiert Logins über
 * pm2-Restarts hinweg, siehe src/services/session-store.ts).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SessionData } from 'express-session';
import { SqliteSessionStore } from './session-store.js';

function makeSession(maxAgeMs: number): SessionData {
  return {
    cookie: {
      originalMaxAge: maxAgeMs,
      expires: new Date(Date.now() + maxAgeMs),
      secure: false,
      httpOnly: true,
      path: '/',
    },
    passport: { user: 'test-user-id' },
  } as unknown as SessionData;
}

describe('SqliteSessionStore', () => {
  let dbPath: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-')), 'sessions.db');
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('speichert und liest eine Session (Roundtrip)', async () => {
    store = new SqliteSessionStore({ dbPath });
    const session = makeSession(60_000);

    await new Promise<void>((resolve, reject) => {
      store.set('sid-1', session, (err) => (err ? reject(err) : resolve()));
    });

    const loaded = await new Promise<SessionData | null | undefined>((resolve, reject) => {
      store.get('sid-1', (err, sess) => (err ? reject(err) : resolve(sess)));
    });

    expect(loaded).toBeTruthy();
    expect((loaded as unknown as { passport: { user: string } }).passport.user).toBe('test-user-id');
  });

  it('destroy löscht die Session', async () => {
    store = new SqliteSessionStore({ dbPath });
    const session = makeSession(60_000);

    await new Promise<void>((resolve, reject) => {
      store.set('sid-destroy', session, (err) => (err ? reject(err) : resolve()));
    });

    await new Promise<void>((resolve, reject) => {
      store.destroy('sid-destroy', (err) => (err ? reject(err) : resolve()));
    });

    const loaded = await new Promise<SessionData | null | undefined>((resolve, reject) => {
      store.get('sid-destroy', (err, sess) => (err ? reject(err) : resolve(sess)));
    });

    expect(loaded).toBeFalsy();
  });

  it('touch verlängert das Ablaufdatum', async () => {
    store = new SqliteSessionStore({ dbPath });
    const session = makeSession(60_000);

    await new Promise<void>((resolve, reject) => {
      store.set('sid-touch', session, (err) => (err ? reject(err) : resolve()));
    });

    const expiresBefore = getRawExpires(dbPath, 'sid-touch');

    // Neue, spätere expires im Session-Objekt simulieren (rolling: true setzt das pro Request).
    const touchedSession = makeSession(60_000 * 60); // deutlich länger
    await new Promise<void>((resolve, reject) => {
      store.touch('sid-touch', touchedSession, (err) => (err ? reject(err) : resolve()));
    });

    const expiresAfter = getRawExpires(dbPath, 'sid-touch');
    expect(expiresAfter).toBeGreaterThan(expiresBefore);
  });

  it('liefert abgelaufene Sessions bei get nicht aus und räumt sie beim Cleanup weg', async () => {
    store = new SqliteSessionStore({ dbPath });
    const expiredSession = makeSession(-1000); // bereits abgelaufen

    await new Promise<void>((resolve, reject) => {
      store.set('sid-expired', expiredSession, (err) => (err ? reject(err) : resolve()));
    });

    const loaded = await new Promise<SessionData | null | undefined>((resolve, reject) => {
      store.get('sid-expired', (err, sess) => (err ? reject(err) : resolve(sess)));
    });
    expect(loaded).toBeFalsy();

    // Cleanup läuft synchron und entfernt die abgelaufene Zeile physisch.
    store.cleanupExpired();

    const raw = getRawRow(dbPath, 'sid-expired');
    expect(raw).toBeUndefined();
  });

  it('überlebt einen Neustart (zweite Store-Instanz auf derselben Datei liest die Session)', async () => {
    store = new SqliteSessionStore({ dbPath });
    const session = makeSession(60_000);

    await new Promise<void>((resolve, reject) => {
      store.set('sid-restart', session, (err) => (err ? reject(err) : resolve()));
    });
    store.close();

    const store2 = new SqliteSessionStore({ dbPath });
    try {
      const loaded = await new Promise<SessionData | null | undefined>((resolve, reject) => {
        store2.get('sid-restart', (err, sess) => (err ? reject(err) : resolve(sess)));
      });
      expect(loaded).toBeTruthy();
      expect((loaded as unknown as { passport: { user: string } }).passport.user).toBe('test-user-id');
    } finally {
      store2.close();
    }
  });
});

// Kleine Helfer, die direkt auf der SQLite-Datei nachsehen (unabhängig vom Store,
// um Store-Verhalten von reiner Persistenz zu unterscheiden).
function getRawExpires(dbPath: string, sid: string): number {
  const row = getRawRow(dbPath, sid) as { expires: number } | undefined;
  if (!row) throw new Error(`row ${sid} not found`);
  return row.expires;
}

function getRawRow(dbPath: string, sid: string): unknown {
  const db = new Database(dbPath);
  try {
    return db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
  } finally {
    db.close();
  }
}
