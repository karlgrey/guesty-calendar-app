/**
 * Job Scheduler
 *
 * Manages scheduled execution of ETL jobs.
 */

import { runETLJob } from './etl-job.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Job scheduler state
 */
interface SchedulerState {
  running: boolean;
  intervalId: NodeJS.Timeout | null;
  lastRun: Date | null;
  nextRun: Date | null;
  jobCount: number;
}

const state: SchedulerState = {
  running: false,
  intervalId: null,
  lastRun: null,
  nextRun: null,
  jobCount: 0,
};

/**
 * Execute ETL job with error handling and schedule next run with jitter
 */
async function executeScheduledJob() {
  try {
    logger.info('⏰ Scheduled ETL job triggered');
    state.lastRun = new Date();
    state.jobCount++;

    const result = await runETLJob(false); // force=false for scheduled jobs

    // Log job completion summary
    logger.info(
      {
        jobCount: state.jobCount,
        listingUpserted: result.listing.success && !result.listing.skipped ? 1 : 0,
        listingSkipped: result.listing.skipped || false,
        availabilityRowsUpserted: result.availability.daysCount || 0,
        availabilitySkipped: result.availability.skipped || false,
        durationMs: result.duration,
      },
      '✅ Scheduled ETL job completed'
    );

    // Schedule next run with jitter to prevent thundering herd
    if (state.intervalId) {
      const nextIntervalMs = getJobInterval(true); // Add jitter for next run
      state.nextRun = new Date(Date.now() + nextIntervalMs);

      logger.info(
        {
          nextRun: state.nextRun,
          intervalMs: nextIntervalMs,
          jitterApplied: true,
        },
        '⏱️  Next scheduled run'
      );
    }
  } catch (error) {
    logger.error({ error, jobCount: state.jobCount }, '❌ Scheduled job execution failed');

    // Still schedule next run even on error
    if (state.intervalId) {
      const nextIntervalMs = getJobInterval(true);
      state.nextRun = new Date(Date.now() + nextIntervalMs);
    }
  }
}

/**
 * Get job interval in milliseconds with optional jitter
 * Uses availability TTL as the primary scheduling interval
 *
 * @param withJitter - If true, adds ±5% random jitter to prevent thundering herd
 */
function getJobInterval(withJitter: boolean = false): number {
  // Use availability TTL (in hours) as the interval
  // This ensures we refresh before cache goes stale
  const hours = config.cacheAvailabilityTtl;
  let intervalMs = hours * 60 * 60 * 1000; // Convert to milliseconds

  if (withJitter) {
    // Add ±5% jitter to prevent all instances from syncing at exactly the same time
    const jitterPercent = 0.05;
    const jitter = intervalMs * jitterPercent * (Math.random() * 2 - 1); // Random between -5% and +5%
    intervalMs = Math.floor(intervalMs + jitter);
  }

  return intervalMs;
}

/**
 * Start the job scheduler
 */
export function startScheduler() {
  if (state.running) {
    logger.warn('Scheduler is already running');
    return;
  }

  const intervalMs = getJobInterval();
  const intervalHours = intervalMs / (60 * 60 * 1000);

  logger.info(
    {
      intervalHours,
      intervalMs,
    },
    '📅 Starting job scheduler'
  );

  // Run immediately on start
  executeScheduledJob();

  // Schedule recurring job
  state.intervalId = setInterval(executeScheduledJob, intervalMs);
  state.running = true;

  // Calculate next run
  state.nextRun = new Date(Date.now() + intervalMs);

  logger.info({ nextRun: state.nextRun }, '✅ Scheduler started');
}

/**
 * Stop the job scheduler
 */
export function stopScheduler() {
  if (!state.running) {
    logger.warn('Scheduler is not running');
    return;
  }

  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  state.running = false;
  state.nextRun = null;

  logger.info('⏹️  Scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    running: state.running,
    lastRun: state.lastRun?.toISOString() || null,
    nextRun: state.nextRun?.toISOString() || null,
    jobCount: state.jobCount,
    intervalHours: getJobInterval() / (60 * 60 * 1000),
  };
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return state.running;
}