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
 * Execute ETL job with error handling
 */
async function executeScheduledJob() {
  try {
    logger.info('⏰ Scheduled ETL job triggered');
    state.lastRun = new Date();
    state.jobCount++;

    await runETLJob(false); // force=false for scheduled jobs

    // Calculate next run time
    if (state.intervalId) {
      state.nextRun = new Date(Date.now() + getJobInterval());
      logger.info({ nextRun: state.nextRun }, 'Next scheduled run');
    }
  } catch (error) {
    logger.error({ error }, 'Scheduled job execution failed');
  }
}

/**
 * Get job interval in milliseconds
 * Uses availability TTL as the primary scheduling interval
 */
function getJobInterval(): number {
  // Use availability TTL (in hours) as the interval
  // This ensures we refresh before cache goes stale
  const hours = config.cacheAvailabilityTtl;
  return hours * 60 * 60 * 1000; // Convert to milliseconds
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