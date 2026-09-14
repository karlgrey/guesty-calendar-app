/**
 * SQLite-Session-Store für express-session.
 *
 * Ersetzt den Default-`MemoryStore`, der bei jedem pm2-Restart alle Logins
 * verliert. Eigene, kleine Implementierung (keine neue Dependency) auf
 * better-sqlite3, das im Projekt bereits Kernabhängigkeit ist.
 *
 * Mit `rolling: true` + `resave: false` MUSS `touch()` implementiert sein,
 * sonst verlängert sich die Session-Cookie-Gültigkeit nie (siehe
 * express-session-Doku zu `resave`).
 */
import Database from 'better-sqlite3';
import { Store } from 'express-session';
import type { SessionData } from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

export interface SqliteSessionStoreOptions {
  /** Pfad zur SQLite-Datei (Verzeichnis wird bei Bedarf angelegt). */
  dbPath: string;
  /** Intervall für das automatische Aufräumen abgelaufener Sessions (ms). Default: 1h. */
  cleanupIntervalMs?: number;
  /** Fallback-Lebensdauer (ms), falls eine Session kein `cookie.expires` mitbringt. */
  defaultTtlMs?: number;
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface SessionRow {
  sid: string;
  sess: string;
  expires: number;
}

export class SqliteSessionStore extends Store {
  private readonly db: Database.Database;
  private readonly defaultTtlMs: number;
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(options: SqliteSessionStoreOptions) {
    super();
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;

    const dbDir = path.dirname(options.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    `);

    // Abgelaufene Sessions periodisch physisch entfernen; unref() verhindert,
    // dass der Timer den Prozess am Beenden hindert (relevant für Tests/CLI-Skripte).
    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), intervalMs);
    this.cleanupInterval.unref?.();
  }

  private expiresAtMs(session: SessionData): number {
    if (session.cookie?.expires) {
      const expires = new Date(session.cookie.expires as unknown as string | Date).getTime();
      if (!Number.isNaN(expires)) {
        return expires;
      }
    }
    return Date.now() + this.defaultTtlMs;
  }

  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const row = this.db.prepare('SELECT sid, sess, expires FROM sessions WHERE sid = ?').get(sid) as
        | SessionRow
        | undefined;

      if (!row) {
        return callback(null, null);
      }

      if (row.expires <= Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }

      callback(null, JSON.parse(row.sess) as SessionData);
    } catch (err) {
      logger.error({ err, sid }, 'SqliteSessionStore.get fehlgeschlagen');
      callback(err);
    }
  }

  set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expires = this.expiresAtMs(session);
      this.db
        .prepare(
          'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
            'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
        )
        .run(sid, JSON.stringify(session), expires);
      callback?.();
    } catch (err) {
      logger.error({ err, sid }, 'SqliteSessionStore.set fehlgeschlagen');
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.();
    } catch (err) {
      logger.error({ err, sid }, 'SqliteSessionStore.destroy fehlgeschlagen');
      callback?.(err);
    }
  }

  touch(sid: string, session: SessionData, callback?: () => void): void {
    try {
      const expires = this.expiresAtMs(session);
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
      callback?.();
    } catch (err) {
      logger.error({ err, sid }, 'SqliteSessionStore.touch fehlgeschlagen');
      callback?.();
    }
  }

  length(callback: (err: unknown, length?: number) => void): void {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      callback(null, row.count);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback?: (err?: unknown) => void): void {
    try {
      this.db.exec('DELETE FROM sessions');
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  all(callback: (err: unknown, obj?: SessionData[] | null) => void): void {
    try {
      const rows = this.db.prepare('SELECT sess FROM sessions WHERE expires > ?').all(Date.now()) as {
        sess: string;
      }[];
      callback(
        null,
        rows.map((r) => JSON.parse(r.sess) as SessionData)
      );
    } catch (err) {
      callback(err);
    }
  }

  /** Entfernt abgelaufene Sessions physisch aus der Datenbank. Öffentlich für Tests/manuelle Läufe. */
  cleanupExpired(): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    return result.changes;
  }

  /** Timer stoppen und Verbindung schließen (Tests, sauberer Shutdown). */
  close(): void {
    clearInterval(this.cleanupInterval);
    this.db.close();
  }
}
