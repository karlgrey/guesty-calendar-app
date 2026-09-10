// src/repositories/scheduler-state-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getSchedulerState, setSchedulerState } from './scheduler-state-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setDatabase(db);
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('getSchedulerState', () => {
  it('returns null for a key that was never set (no row)', () => {
    expect(getSchedulerState('dailyConsistencyCheckLastRunDay')).toBeNull();
  });

  it('returns the persisted value after setSchedulerState()', () => {
    setSchedulerState('dailyConsistencyCheckLastRunDay', '2026-09-10');
    expect(getSchedulerState('dailyConsistencyCheckLastRunDay')).toBe('2026-09-10');
  });
});

describe('setSchedulerState', () => {
  it('overwrites an existing value for the same key (upsert, no duplicate row)', () => {
    setSchedulerState('dailyConsistencyCheckLastRunDay', '2026-09-10');
    setSchedulerState('dailyConsistencyCheckLastRunDay', '2026-09-11');

    expect(getSchedulerState('dailyConsistencyCheckLastRunDay')).toBe('2026-09-11');
    const count = db.prepare('SELECT COUNT(*) as count FROM scheduler_state').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('keeps different keys independent', () => {
    setSchedulerState('dailyConsistencyCheckLastRunDay', '2026-09-10');
    setSchedulerState('dailyForceSyncLastRunDay', '2026-09-09');

    expect(getSchedulerState('dailyConsistencyCheckLastRunDay')).toBe('2026-09-10');
    expect(getSchedulerState('dailyForceSyncLastRunDay')).toBe('2026-09-09');
  });
});
