// #772: Tages-Telemetrie der Guesty-Requests (Flush in scheduler_state).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getSchedulerState, setSchedulerState } from '../repositories/scheduler-state-repository.js';
import { emptyRequestCounters, guestyClient } from './guesty-client.js';
import {
  flushGuestyRequestTelemetry,
  getGuestyRequestDailyStats,
  startGuestyTelemetryFlush,
  stopGuestyTelemetryFlush,
  resetGuestyTelemetryForTests,
} from './guesty-request-telemetry.js';

let db: Database.Database;

function c(p: Partial<ReturnType<typeof emptyRequestCounters>>) {
  return { ...emptyRequestCounters(), ...p };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  setDatabase(db);
  resetGuestyTelemetryForTests();
});
afterEach(() => {
  stopGuestyTelemetryFlush();
  vi.useRealTimers();
  resetDatabase();
  db.close();
});

describe('flushGuestyRequestTelemetry', () => {
  it('addiert die Differenz zum letzten Flush auf den Tageseimer', () => {
    const now = new Date('2026-10-06T10:00:00Z');
    flushGuestyRequestTelemetry(now, c({ total: 5, conversationList: 2, other: 3 }));
    flushGuestyRequestTelemetry(now, c({ total: 8, conversationList: 3, other: 4, retries: 1, rateLimited429: 1 }));
    const stored = JSON.parse(getSchedulerState('guesty_requests:2026-10-06')!);
    expect(stored).toMatchObject({ total: 8, conversationList: 3, other: 4, retries: 1, rateLimited429: 1 });
  });

  it('nutzt das Datum in Europe/Berlin (23:30 UTC im Sommer = nächster Tag)', () => {
    flushGuestyRequestTelemetry(new Date('2026-10-06T23:30:00Z'), c({ total: 1 }));
    expect(getSchedulerState('guesty_requests:2026-10-07')).not.toBeNull();
    expect(getSchedulerState('guesty_requests:2026-10-06')).toBeNull();
  });

  it('löscht Keys älter als 30 Tage', () => {
    setSchedulerState('guesty_requests:2026-08-01', '{}');
    setSchedulerState('guesty_requests:2026-09-20', '{}');
    flushGuestyRequestTelemetry(new Date('2026-10-06T10:00:00Z'), c({ total: 1 }));
    expect(getSchedulerState('guesty_requests:2026-08-01')).toBeNull();
    expect(getSchedulerState('guesty_requests:2026-09-20')).not.toBeNull();
  });

  it('schreibt bei Nulldifferenz nichts', () => {
    flushGuestyRequestTelemetry(new Date('2026-10-06T10:00:00Z'), c({}));
    expect(getSchedulerState('guesty_requests:2026-10-06')).toBeNull();
  });

  it('wirft nie bei DB-Fehlern', () => {
    resetDatabase();
    db.close();
    expect(() => flushGuestyRequestTelemetry(new Date(), c({ total: 1 }))).not.toThrow();
    db = new Database(':memory:'); // für afterEach
    setDatabase(db);
  });
});

describe('getGuestyRequestDailyStats', () => {
  it('liefert die letzten Tage, neueste zuerst, fehlende Tage als Nullzähler', () => {
    setSchedulerState('guesty_requests:2026-10-05', JSON.stringify(c({ total: 7 })));
    const stats = getGuestyRequestDailyStats(3, new Date('2026-10-06T10:00:00Z'), c({ total: 2 }));
    expect(stats.map((s) => s.date)).toEqual(['2026-10-06', '2026-10-05', '2026-10-04']);
    expect(stats[0].total).toBe(2); // vorher geflusht
    expect(stats[1].total).toBe(7);
    expect(stats[2].total).toBe(0);
  });
});

describe('startGuestyTelemetryFlush', () => {
  it('flusht periodisch und lässt sich stoppen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    vi.spyOn(guestyClient, 'getRequestCounters').mockReturnValue(c({ total: 4 }));
    startGuestyTelemetryFlush(1);
    vi.advanceTimersByTime(61_000);
    stopGuestyTelemetryFlush();
    expect(JSON.parse(getSchedulerState('guesty_requests:2026-10-06')!).total).toBe(4);
  });
});
