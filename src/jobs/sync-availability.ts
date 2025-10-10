/**
 * Sync Availability Job
 *
 * Fetches 12 months of availability data from Guesty API and updates the cache.
 */

import { guestyClient } from '../services/guesty-client.js';
import {
  upsertAvailabilityBatch,
  deleteOldAvailability,
  getAvailabilityDateRange,
} from '../repositories/availability-repository.js';
import { mapAvailabilityBatch } from '../mappers/availability-mapper.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';

export interface SyncAvailabilityResult {
  success: boolean;
  listingId: string;
  daysCount?: number;
  skipped?: boolean;
  error?: string;
  partialSuccess?: boolean;
}

/**
 * Check if availability cache needs refresh
 */
function needsAvailabilityRefresh(listingId: string, ttlMinutes: number): boolean {
  try {
    const dateRange = getAvailabilityDateRange(listingId);

    // If no data exists, needs refresh
    if (!dateRange) {
      return true;
    }

    // Check if the max date is at least 11 months in the future
    const today = new Date();
    const maxDate = new Date(dateRange.maxDate);
    const monthsDiff = (maxDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 30);

    // If coverage is less than 11 months, needs refresh
    if (monthsDiff < 11) {
      logger.debug(
        { listingId, monthsCoverage: monthsDiff.toFixed(1) },
        'Availability cache has insufficient future coverage'
      );
      return true;
    }

    // Check if data is stale (based on TTL)
    // For simplicity, we'll consider data stale if it was last updated more than TTL hours ago
    // This is a heuristic since we don't track per-row sync times for availability
    return false; // If we have good coverage, assume it's fresh enough
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to check availability refresh status');
    return true; // If error, assume refresh is needed
  }
}

/**
 * Sync availability for a single listing
 */
export async function syncAvailability(listingId: string, force: boolean = false): Promise<SyncAvailabilityResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId, force }, 'Starting availability sync');

    // Check if refresh is needed (unless forced)
    if (!force && !needsAvailabilityRefresh(listingId, config.cacheAvailabilityTtl)) {
      logger.info({ listingId }, 'Availability cache is fresh, skipping sync');
      return {
        success: true,
        listingId,
        skipped: true,
      };
    }

    // Fetch 12 months of calendar data from Guesty API
    const guestyCalendar = await guestyClient.get12MonthsCalendar(listingId);

    if (!guestyCalendar || guestyCalendar.length === 0) {
      logger.warn({ listingId }, 'No calendar data returned from Guesty API');
      return {
        success: false,
        listingId,
        error: 'No calendar data returned',
      };
    }

    // Map to internal model
    const availabilities = mapAvailabilityBatch(guestyCalendar);

    // Delete old availability data (past dates)
    const today = new Date().toISOString().split('T')[0];
    const deletedCount = deleteOldAvailability(listingId, today);

    if (deletedCount > 0) {
      logger.debug({ listingId, deletedCount }, 'Deleted old availability records');
    }

    // Batch upsert to database (uses transaction for performance)
    const upsertedCount = upsertAvailabilityBatch(availabilities);

    const duration = Date.now() - startTime;

    logger.info(
      {
        listingId,
        daysCount: upsertedCount,
        deletedCount,
        duration,
      },
      'Availability synced successfully'
    );

    return {
      success: true,
      listingId,
      daysCount: upsertedCount,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        error,
        listingId,
        duration,
      },
      'Failed to sync availability'
    );

    return {
      success: false,
      listingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sync availability for the configured property
 */
export async function syncConfiguredAvailability(force: boolean = false): Promise<SyncAvailabilityResult> {
  return syncAvailability(config.guestyPropertyId, force);
}

/**
 * Sync availability with chunked requests (fetch data in smaller date ranges)
 * Useful for handling large date ranges or API rate limits
 */
export async function syncAvailabilityChunked(
  listingId: string,
  chunkMonths: number = 3
): Promise<SyncAvailabilityResult> {
  const startTime = Date.now();
  let totalDaysCount = 0;
  let hasErrors = false;
  const errors: string[] = [];

  try {
    logger.info({ listingId, chunkMonths }, 'Starting chunked availability sync');

    const today = new Date();

    // Generate chunks (3-month intervals)
    const chunks: Array<{ start: string; end: string }> = [];
    for (let i = 0; i < 12; i += chunkMonths) {
      const startDate = new Date(today);
      startDate.setMonth(startDate.getMonth() + i);

      const endDate = new Date(today);
      endDate.setMonth(endDate.getMonth() + Math.min(i + chunkMonths, 12));

      chunks.push({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
    }

    // Fetch and upsert each chunk
    for (const chunk of chunks) {
      try {
        logger.debug({ listingId, ...chunk }, 'Fetching calendar chunk');

        const guestyCalendar = await guestyClient.getCalendar(listingId, chunk.start, chunk.end);

        if (guestyCalendar && guestyCalendar.length > 0) {
          const availabilities = mapAvailabilityBatch(guestyCalendar);
          const upsertedCount = upsertAvailabilityBatch(availabilities);
          totalDaysCount += upsertedCount;

          logger.debug({ listingId, chunk, daysCount: upsertedCount }, 'Calendar chunk synced');
        }
      } catch (error) {
        hasErrors = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Chunk ${chunk.start} to ${chunk.end}: ${errorMsg}`);
        logger.error({ error, listingId, chunk }, 'Failed to sync calendar chunk');

        // Continue with next chunk even if one fails
      }
    }

    // Delete old availability data
    const today_str = today.toISOString().split('T')[0];
    const deletedCount = deleteOldAvailability(listingId, today_str);

    const duration = Date.now() - startTime;

    if (hasErrors) {
      logger.warn(
        {
          listingId,
          daysCount: totalDaysCount,
          deletedCount,
          errorCount: errors.length,
          duration,
        },
        'Availability sync completed with errors'
      );

      return {
        success: false,
        listingId,
        daysCount: totalDaysCount,
        partialSuccess: totalDaysCount > 0,
        error: errors.join('; '),
      };
    }

    logger.info(
      {
        listingId,
        daysCount: totalDaysCount,
        deletedCount,
        duration,
      },
      'Chunked availability synced successfully'
    );

    return {
      success: true,
      listingId,
      daysCount: totalDaysCount,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        error,
        listingId,
        duration,
      },
      'Failed to sync chunked availability'
    );

    return {
      success: false,
      listingId,
      daysCount: totalDaysCount,
      partialSuccess: totalDaysCount > 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}