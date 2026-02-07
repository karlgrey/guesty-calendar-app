/**
 * Job Scheduler
 *
 * Manages scheduled execution of ETL jobs.
 */

import { runETLJob } from './etl-job.js';
import { sendWeeklySummaryEmailForProperty, shouldSendWeeklyEmailForProperty } from './weekly-email.js';
import { syncAnalytics, shouldSyncAnalytics } from './sync-analytics.js';
import { syncGoogleCalendarForProperty } from './sync-google-calendar.js';
import { config } from '../config/index.js';
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
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
  // Per-property tracking for weekly emails
  propertyWeeklyEmailSent: Map<string, Date>;
  dailyForceIntervalId: NodeJS.Timeout | null;
  lastDailyForceSync: Date | null;
  analyticsIntervalId: NodeJS.Timeout | null;
  lastAnalyticsSync: Date | null;
  googleCalendarIntervalId: NodeJS.Timeout | null;
  propertyGoogleCalendarLastSync: Map<string, Date>;
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
  propertyWeeklyEmailSent: new Map(),
  dailyForceIntervalId: null,
  lastDailyForceSync: null,
  analyticsIntervalId: null,
  lastAnalyticsSync: null,
  googleCalendarIntervalId: null,
  propertyGoogleCalendarLastSync: new Map(),
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
 * Check and send weekly email for a specific property
 */
async function checkAndSendWeeklyEmailForProperty(property: PropertyConfig) {
  const { slug, name, weeklyReport } = property;

  if (!weeklyReport.enabled) {
    return;
  }

  // Check if we should send email now for this property
  if (shouldSendWeeklyEmailForProperty(property)) {
    // Check if we already sent today for this property (to prevent duplicate sends)
    const today = new Date().toDateString();
    const lastSent = state.propertyWeeklyEmailSent.get(slug)?.toDateString();

    if (lastSent === today) {
      logger.debug({ propertySlug: slug }, 'Weekly email already sent today for property, skipping');
      return;
    }

    logger.info({ propertySlug: slug, propertyName: name }, '📧 Weekly email conditions met, sending...');
    const result = await sendWeeklySummaryEmailForProperty(property);

    if (result.sent) {
      state.propertyWeeklyEmailSent.set(slug, new Date());
      state.lastWeeklyEmailSent = new Date();
    }
  }
}

/**
 * Check and send weekly email if conditions are met (for all properties)
 */
async function checkAndSendWeeklyEmail() {
  try {
    state.lastWeeklyEmailCheck = new Date();

    const properties = getAllProperties();

    // Multi-property mode
    if (properties.length > 0) {
      for (const property of properties) {
        await checkAndSendWeeklyEmailForProperty(property);
      }
      return;
    }

    // Legacy single-property mode
    if (!config.weeklyReportEnabled) {
      return;
    }

    // Create legacy property config and check
    const legacyProperty: PropertyConfig = {
      slug: 'default',
      guestyPropertyId: config.guestyPropertyId || '',
      name: 'Default Property',
      timezone: config.propertyTimezone,
      currency: config.propertyCurrency,
      bookingRecipientEmail: config.bookingRecipientEmail,
      bookingSenderName: config.bookingSenderName,
      weeklyReport: {
        enabled: config.weeklyReportEnabled as boolean,
        recipients: config.weeklyReportRecipients as string[],
        day: config.weeklyReportDay,
        hour: config.weeklyReportHour,
      },
      ga4: {
        enabled: config.ga4Enabled as boolean,
        propertyId: config.ga4PropertyId,
        keyFilePath: config.ga4KeyFilePath,
        syncHour: config.ga4SyncHour,
      },
    };

    await checkAndSendWeeklyEmailForProperty(legacyProperty);
  } catch (error) {
    logger.error({ error }, 'Error in weekly email check');
  }
}

/**
 * Check and sync GA4 analytics if conditions are met
 */
async function checkAndSyncAnalytics() {
  try {
    if (!config.ga4Enabled) {
      return;
    }

    // Check if we should sync now
    if (shouldSyncAnalytics()) {
      // Check if we already synced today (to prevent duplicate syncs)
      const today = new Date().toDateString();
      const lastSync = state.lastAnalyticsSync?.toDateString();

      if (lastSync === today) {
        logger.debug('Analytics already synced today, skipping');
        return;
      }

      logger.info('📊 Analytics sync conditions met, syncing...');
      const result = await syncAnalytics(30); // Sync last 30 days

      if (result.success) {
        state.lastAnalyticsSync = new Date();
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in analytics sync check');
  }
}

/**
 * Check and sync Google Calendar for all enabled properties
 */
async function checkAndSyncGoogleCalendar() {
  try {
    const properties = getAllProperties();

    for (const property of properties) {
      if (!property.googleCalendar?.enabled || !property.googleCalendar.calendarId) {
        continue;
      }

      try {
        const result = await syncGoogleCalendarForProperty(property);
        if (result.success) {
          state.propertyGoogleCalendarLastSync.set(property.slug, new Date());
        }
      } catch (error) {
        logger.error(
          { error, propertySlug: property.slug },
          'Error syncing Google Calendar for property'
        );
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in Google Calendar sync check');
  }
}

/**
 * Check if daily forced sync should run (at 2 AM)
 */
function shouldRunDailyForceSync(): boolean {
  const now = new Date();
  const currentHour = now.getHours();

  // Run at 2 AM
  if (currentHour !== 2) {
    return false;
  }

  // Check if we already ran today
  const today = now.toDateString();
  const lastRun = state.lastDailyForceSync?.toDateString();

  return lastRun !== today;
}

/**
 * Execute daily forced sync to ensure all data is up-to-date
 */
async function checkAndRunDailyForceSync() {
  try {
    if (!shouldRunDailyForceSync()) {
      return;
    }

    logger.info('🔄 Daily forced sync triggered - refreshing all data');

    const result = await runETLJob(true); // force=true to bypass cache checks

    state.lastDailyForceSync = new Date();

    if (result.success) {
      logger.info(
        {
          listingUpserted: result.listing.success && !result.listing.skipped ? 1 : 0,
          availabilityRowsUpserted: result.availability.daysCount || 0,
          durationMs: result.duration,
          lastDailyForceSync: state.lastDailyForceSync?.toISOString(),
        },
        '✅ Daily forced sync completed successfully'
      );
    } else {
      logger.error(
        {
          listingError: result.listing.error,
          availabilityError: result.availability.error,
          lastDailyForceSync: state.lastDailyForceSync?.toISOString(),
        },
        '⚠️  Daily forced sync completed with errors'
      );
    }
  } catch (error) {
    logger.error({ error }, '❌ Error in daily forced sync');
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
  const properties = getAllProperties();
  const hasWeeklyReportEnabled = properties.length > 0
    ? properties.some(p => p.weeklyReport.enabled)
    : config.weeklyReportEnabled;

  if (hasWeeklyReportEnabled) {
    if (properties.length > 0) {
      logger.info(
        {
          propertyCount: properties.length,
          properties: properties
            .filter(p => p.weeklyReport.enabled)
            .map(p => ({
              slug: p.slug,
              day: p.weeklyReport.day,
              hour: p.weeklyReport.hour,
              recipients: p.weeklyReport.recipients,
            })),
        },
        '📧 Starting multi-property weekly email scheduler'
      );
    } else {
      logger.info(
        {
          weeklyReportDay: config.weeklyReportDay,
          weeklyReportHour: config.weeklyReportHour,
          recipients: config.weeklyReportRecipients,
        },
        '📧 Starting weekly email scheduler'
      );
    }

    // Check immediately on start
    checkAndSendWeeklyEmail();

    // Check every hour
    const hourlyInterval = 60 * 60 * 1000; // 1 hour
    state.weeklyEmailIntervalId = setInterval(checkAndSendWeeklyEmail, hourlyInterval);
  }

  // Start daily forced sync checker (runs every hour, executes at 2 AM)
  logger.info('🔄 Starting daily forced sync scheduler (runs at 2 AM)');

  // Check immediately on start
  checkAndRunDailyForceSync();

  // Check every hour
  const hourlyInterval = 60 * 60 * 1000; // 1 hour
  state.dailyForceIntervalId = setInterval(checkAndRunDailyForceSync, hourlyInterval);

  // Start GA4 analytics sync scheduler (runs every hour, executes at configured hour)
  if (config.ga4Enabled) {
    logger.info(
      {
        ga4PropertyId: config.ga4PropertyId,
        ga4SyncHour: config.ga4SyncHour,
      },
      '📊 Starting GA4 analytics sync scheduler'
    );

    // Check immediately on start
    checkAndSyncAnalytics();

    // Check every hour
    state.analyticsIntervalId = setInterval(checkAndSyncAnalytics, hourlyInterval);
  }

  // Start Google Calendar sync scheduler (runs every 30 min, same as ETL)
  const hasGoogleCalendarEnabled = properties.some(p => p.googleCalendar?.enabled);
  if (hasGoogleCalendarEnabled) {
    const gcalProperties = properties.filter(p => p.googleCalendar?.enabled);
    logger.info(
      {
        propertyCount: gcalProperties.length,
        properties: gcalProperties.map(p => ({ slug: p.slug, calendarId: p.googleCalendar?.calendarId })),
      },
      '📅 Starting Google Calendar sync scheduler'
    );

    // Sync after a short delay on start (let ETL populate data first)
    setTimeout(() => checkAndSyncGoogleCalendar(), 30_000);

    // Sync every 30 minutes
    const gcalInterval = 30 * 60 * 1000;
    state.googleCalendarIntervalId = setInterval(checkAndSyncGoogleCalendar, gcalInterval);
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

  if (state.dailyForceIntervalId) {
    clearInterval(state.dailyForceIntervalId);
    state.dailyForceIntervalId = null;
  }

  if (state.analyticsIntervalId) {
    clearInterval(state.analyticsIntervalId);
    state.analyticsIntervalId = null;
  }

  if (state.googleCalendarIntervalId) {
    clearInterval(state.googleCalendarIntervalId);
    state.googleCalendarIntervalId = null;
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
    lastDailyForceSync: state.lastDailyForceSync?.toISOString() || null,
    lastAnalyticsSync: state.lastAnalyticsSync?.toISOString() || null,
    googleCalendarLastSync: Object.fromEntries(
      Array.from(state.propertyGoogleCalendarLastSync.entries()).map(
        ([slug, date]) => [slug, date.toISOString()]
      )
    ),
  };
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return state.running;
}