/**
 * Scheduler State Repository
 *
 * Generic key/value persistence for scheduler markers that must survive a
 * process restart (e.g. "did the daily consistency check already run
 * today?"). RAM-only markers in `src/jobs/scheduler.ts`'s `state` object
 * don't survive a deploy mid-hour — see migration 026 / SmartTasks #603.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export function getSchedulerState(key: string): string | null {
  const db = getDatabase();
  try {
    const row = db.prepare(`SELECT value FROM scheduler_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch (error) {
    logger.error({ error, key }, 'Failed to get scheduler state');
    throw new DatabaseError(`Failed to get scheduler state: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function setSchedulerState(key: string, value: string): void {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO scheduler_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value);
  } catch (error) {
    logger.error({ error, key, value }, 'Failed to set scheduler state');
    throw new DatabaseError(`Failed to set scheduler state: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
