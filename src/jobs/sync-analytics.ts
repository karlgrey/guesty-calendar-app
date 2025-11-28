/**
 * Analytics Sync Job
 *
 * Fetches GA4 analytics data and stores it in the database.
 * Runs daily at a configured hour.
 */

import { ga4Client } from '../services/ga4-client.js';
import {
  upsertDailyAnalyticsBatch,
  replaceTopPages,
  logSync,
} from '../repositories/analytics-repository.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { toZonedTime } from 'date-fns-tz';

/**
 * Sync result
 */
export interface AnalyticsSyncResult {
  success: boolean;
  recordsSynced: number;
  topPagesUpdated: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * Run the analytics sync job
 *
 * @param days Number of days to sync (default: 30)
 */
export async function syncAnalytics(days: number = 30): Promise<AnalyticsSyncResult> {
  const startTime = Date.now();

  logger.info({ days }, '📊 Starting GA4 analytics sync');

  if (!ga4Client.isEnabled()) {
    logger.info('GA4 analytics is not enabled, skipping sync');
    return {
      success: true,
      recordsSynced: 0,
      topPagesUpdated: false,
    };
  }

  try {
    // Fetch analytics from GA4
    const analytics = await ga4Client.getAnalytics(days);

    // Store daily data
    const recordsSynced = upsertDailyAnalyticsBatch(analytics.dailyData);

    // Store top pages with today's date
    const today = new Date().toISOString().split('T')[0];
    replaceTopPages(today, analytics.topPages);

    // Log the sync
    logSync(analytics.startDate, analytics.endDate, recordsSynced, true);

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        recordsSynced,
        topPagesCount: analytics.topPages.length,
        totalPageviews: analytics.totalPageviews,
        totalUsers: analytics.totalUsers,
        durationMs,
      },
      '✅ GA4 analytics sync completed'
    );

    return {
      success: true,
      recordsSynced,
      topPagesUpdated: true,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error({ error, durationMs }, '❌ GA4 analytics sync failed');

    // Log the failed sync
    const today = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    logSync(startDate.toISOString().split('T')[0], today, 0, false, errorMessage);

    return {
      success: false,
      recordsSynced: 0,
      topPagesUpdated: false,
      error: errorMessage,
      durationMs,
    };
  }
}

/**
 * Check if analytics sync should run now
 * Runs at the configured hour in the property timezone
 */
export function shouldSyncAnalytics(): boolean {
  if (!ga4Client.isEnabled()) {
    return false;
  }

  const now = new Date();
  const timezone = config.propertyTimezone || 'Europe/Berlin';

  // Convert current UTC time to property timezone
  const zonedTime = toZonedTime(now, timezone);
  const currentHour = zonedTime.getHours();

  return currentHour === config.ga4SyncHour;
}
