/**
 * Job Scheduler
 *
 * Manages scheduled execution of ETL jobs.
 */

import { runETLJob } from './etl-job.js';
import { sendWeeklySummaryEmail, shouldSendWeeklyEmail } from './weekly-email.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Job scheduler state
 */
interface SchedulerState {
  running: boolean;
  intervalId: NodeJS.Timeout | null;
  lastRun: Date | null;
  lastSuccessfulRun: Date | null;
  lastFailedRun: Date | null;
  nextRun: Date | null;
  jobCount: number;
  successCount: number;
  failureCount: number;
  weeklyEmailIntervalId: NodeJS.Timeout | null;
  lastWeeklyEmailCheck: Date | null;
  lastWeeklyEmailSent: Date | null;
}

const state: SchedulerState = {
  running: false,
  intervalId: null,
  lastRun: null,
  lastSuccessfulRun: null,
  lastFailedRun: null,
  nextRun: null,
  jobCount: 0,
  successCount: 0,
  failureCount: 0,
  weeklyEmailIntervalId: null,
  lastWeeklyEmailCheck: null,
  lastWeeklyEmailSent: null,
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

    // Track success/failure
    if (result.success) {
      state.lastSuccessfulRun = new Date();
      state.successCount++;

      logger.info(
        {
          jobCount: state.jobCount,
          listingUpserted: result.listing.success && !result.listing.skipped ? 1 : 0,
          listingSkipped: result.listing.skipped || false,
          availabilityRowsUpserted: result.availability.daysCount || 0,
          availabilitySkipped: result.availability.skipped || false,
          durationMs: result.duration,
        },
        '✅ Scheduled ETL job completed successfully'
      );
    } else {
      state.lastFailedRun = new Date();
      state.failureCount++;

      logger.warn(
        {
          jobCount: state.jobCount,
          listingError: result.listing.error,
          availabilityError: result.availability.error,
          durationMs: result.duration,
        },
        '⚠️  Scheduled ETL job completed with errors'
      );
    }

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
    state.lastFailedRun = new Date();
    state.failureCount++;

    logger.error({ error, jobCount: state.jobCount }, '❌ Scheduled job execution failed');

    // Still schedule next run even on error
    if (state.intervalId) {
      const nextIntervalMs = getJobInterval(true);
      state.nextRun = new Date(Date.now() + nextIntervalMs);
    }
  }
}

/**
 * Check and send weekly email if conditions are met
 */
async function checkAndSendWeeklyEmail() {
  try {
    state.lastWeeklyEmailCheck = new Date();

    if (!config.weeklyReportEnabled) {
      return;
    }

    // Check if we should send email now
    if (shouldSendWeeklyEmail()) {
      // Check if we already sent today (to prevent duplicate sends)
      const today = new Date().toDateString();
      const lastSent = state.lastWeeklyEmailSent?.toDateString();

      if (lastSent === today) {
        logger.debug('Weekly email already sent today, skipping');
        return;
      }

      logger.info('📧 Weekly email conditions met, sending...');
      const result = await sendWeeklySummaryEmail();

      if (result.sent) {
        state.lastWeeklyEmailSent = new Date();
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in weekly email check');
  }
}

/**
 * Get job interval in milliseconds with optional jitter
 * Uses availability TTL as the primary scheduling interval
 *
 * @param withJitter - If true, adds ±5% random jitter to prevent thundering herd
 */
function getJobInterval(withJitter: boolean = false): number {
  // Use availability TTL (in minutes) as the interval
  // This ensures we refresh before cache goes stale
  const minutes = config.cacheAvailabilityTtl;
  let intervalMs = minutes * 60 * 1000; // Convert to milliseconds

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
  const intervalMinutes = intervalMs / (60 * 1000);

  logger.info(
    {
      intervalMinutes,
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

  // Start weekly email checker (runs every hour)
  if (config.weeklyReportEnabled) {
    logger.info(
      {
        weeklyReportDay: config.weeklyReportDay,
        weeklyReportHour: config.weeklyReportHour,
        recipients: config.weeklyReportRecipients,
      },
      '📧 Starting weekly email scheduler'
    );

    // Check immediately on start
    checkAndSendWeeklyEmail();

    // Check every hour
    const hourlyInterval = 60 * 60 * 1000; // 1 hour
    state.weeklyEmailIntervalId = setInterval(checkAndSendWeeklyEmail, hourlyInterval);
  }
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

  if (state.weeklyEmailIntervalId) {
    clearInterval(state.weeklyEmailIntervalId);
    state.weeklyEmailIntervalId = null;
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
    lastSuccessfulRun: state.lastSuccessfulRun?.toISOString() || null,
    lastFailedRun: state.lastFailedRun?.toISOString() || null,
    nextRun: state.nextRun?.toISOString() || null,
    jobCount: state.jobCount,
    successCount: state.successCount,
    failureCount: state.failureCount,
    intervalMinutes: getJobInterval() / (60 * 1000),
  };
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return state.running;
}