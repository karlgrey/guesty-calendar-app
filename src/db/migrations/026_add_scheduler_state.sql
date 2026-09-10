-- Migration: generic scheduler state (key/value)
-- Created: 2026-09-10
-- SmartTasks #603: the daily calendar consistency check (#484) only tracked
-- "did we already run today" in RAM (scheduler.ts state.lastConsistencyCheck).
-- A deploy restart mid-hour (2026-09-10, 06:27:51Z) wiped the RAM marker, so
-- the hourly checker ran again inside the same 6 AM hour and sent a second
-- alert mail. This table persists a "last run day" marker per job so it
-- survives a process restart. Generic key/value shape (not a per-job table
-- like airbnb_mail_state, migration 013) since several daily scheduler jobs
-- can share it — first consumers: the daily consistency check and the daily
-- forced sync (same RAM-marker pattern, same fix).

CREATE TABLE scheduler_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
