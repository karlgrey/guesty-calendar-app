/**
 * Guesty-Request-Telemetrie je Tag (#772).
 *
 * Flush-basiert, nicht im Request-Pfad: der guestyClient zählt prozessweit
 * monoton; hier wird periodisch die Differenz zum letzten Snapshot auf einen
 * Tageseimer in scheduler_state (Key `guesty_requests:YYYY-MM-DD`, Datum in
 * Europe/Berlin) addiert. Telemetrie wirft nie — DB-Fehler nur als warn-Log.
 */

import { formatInTimeZone } from 'date-fns-tz';
import {
  guestyClient,
  emptyRequestCounters,
  diffRequestCounters,
  type GuestyRequestCounters,
} from './guesty-client.js';
import {
  getSchedulerState,
  setSchedulerState,
  deleteSchedulerStateKeysBefore,
} from '../repositories/scheduler-state-repository.js';
import logger from '../utils/logger.js';

const KEY_PREFIX = 'guesty_requests:';
const TIMEZONE = 'Europe/Berlin';
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuestyRequestDailyStat extends GuestyRequestCounters {
  date: string;
}

let lastSnapshot: GuestyRequestCounters = emptyRequestCounters();
let flushTimer: NodeJS.Timeout | null = null;

/** Nur für Tests: Snapshot zurücksetzen. */
export function resetGuestyTelemetryForTests(): void {
  lastSnapshot = emptyRequestCounters();
}

function berlinDate(d: Date): string {
  return formatInTimeZone(d, TIMEZONE, 'yyyy-MM-dd');
}

function readBucket(date: string): GuestyRequestCounters {
  const base = emptyRequestCounters();
  const raw = getSchedulerState(`${KEY_PREFIX}${date}`);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<GuestyRequestCounters>;
    for (const k of Object.keys(base) as (keyof GuestyRequestCounters)[]) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isFinite(v)) base[k] = v;
    }
  } catch {
    // kaputter Eintrag → wie leer behandeln
  }
  return base;
}

export function flushGuestyRequestTelemetry(
  now: Date = new Date(),
  counters: GuestyRequestCounters = guestyClient.getRequestCounters()
): void {
  try {
    const delta = diffRequestCounters(counters, lastSnapshot);
    const keys = Object.keys(delta) as (keyof GuestyRequestCounters)[];
    for (const k of keys) if (delta[k] < 0) delta[k] = 0;

    if (keys.some((k) => delta[k] > 0)) {
      const date = berlinDate(now);
      const bucket = readBucket(date);
      for (const k of keys) bucket[k] += delta[k];
      setSchedulerState(`${KEY_PREFIX}${date}`, JSON.stringify(bucket));
      lastSnapshot = { ...counters };
    }

    const cutoff = berlinDate(new Date(now.getTime() - RETENTION_DAYS * DAY_MS));
    deleteSchedulerStateKeysBefore(KEY_PREFIX, cutoff);
  } catch (error) {
    logger.warn({ error }, 'Guesty request telemetry flush failed');
  }
}

/** Letzte `days` Tage (heute zuerst), fehlende Tage als Nullzähler. */
export function getGuestyRequestDailyStats(
  days = 7,
  now: Date = new Date(),
  counters?: GuestyRequestCounters
): GuestyRequestDailyStat[] {
  flushGuestyRequestTelemetry(now, counters);
  const result: GuestyRequestDailyStat[] = [];
  try {
    for (let i = 0; i < days; i++) {
      const date = berlinDate(new Date(now.getTime() - i * DAY_MS));
      result.push({ date, ...readBucket(date) });
    }
  } catch (error) {
    logger.warn({ error }, 'Guesty request telemetry read failed');
  }
  return result;
}

export function startGuestyTelemetryFlush(intervalMinutes = 5): void {
  stopGuestyTelemetryFlush();
  flushTimer = setInterval(() => flushGuestyRequestTelemetry(), intervalMinutes * 60 * 1000);
  flushTimer.unref();
}

export function stopGuestyTelemetryFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
