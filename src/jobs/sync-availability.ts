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
import {
  upsertReservationBatch,
  deleteOldReservations,
  deleteStaleReservationsInRange,
} from '../repositories/reservation-repository.js';
import { mapAvailabilityBatch } from '../mappers/availability-mapper.js';
import { extractReservationsFromCalendar } from '../mappers/reservation-mapper.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export interface SyncAvailabilityResult {
  success: boolean;
  listingId: string;
  daysCount?: number;
  reservationsCount?: number;
  skipped?: boolean;
  error?: string;
  partialSuccess?: boolean;
}

/**
 * Check if availability cache needs refresh
 */
function needsAvailabilityRefresh(listingId: string): boolean {
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
    if (!force && !needsAvailabilityRefresh(listingId)) {
      logger.info({ listingId }, 'Availability cache is fresh, skipping sync');
      return {
        success: true,
        listingId,
        skipped: true,
      };
    }

    // Fetch 24 months of calendar data: 12 months back + 12 months forward
    const today = new Date();
    const startDate = new Date(today);
    startDate.setMonth(startDate.getMonth() - 12); // 12 months ago
    const endDate = new Date(today);
    endDate.setMonth(endDate.getMonth() + 12); // 12 months ahead

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    logger.info({ listingId, startDate: startDateStr, endDate: endDateStr }, 'Fetching 24 months of calendar data (past 12 + future 12)');

    const guestyCalendar = await guestyClient.getCalendar(listingId, startDateStr, endDateStr);

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

    // Extract reservation data from calendar
    const lastSyncedAt = new Date().toISOString();
    const reservations = extractReservationsFromCalendar(guestyCalendar, lastSyncedAt);

    // Delete very old availability data (older than 13 months to keep some buffer)
    const oldDataCutoff = new Date(today);
    oldDataCutoff.setMonth(oldDataCutoff.getMonth() - 13);
    const oldDataCutoffStr = oldDataCutoff.toISOString().split('T')[0];
    const deletedAvailabilityCount = deleteOldAvailability(listingId, oldDataCutoffStr);
    const deletedReservationsCount = deleteOldReservations(listingId, oldDataCutoffStr);

    if (deletedAvailabilityCount > 0 || deletedReservationsCount > 0) {
      logger.debug(
        { listingId, deletedAvailabilityCount, deletedReservationsCount },
        'Deleted old records'
      );
    }

    // Batch upsert to database (uses transaction for performance)
    const upsertedCount = upsertAvailabilityBatch(availabilities);
    const upsertedReservationsCount = reservations.length > 0 ? upsertReservationBatch(reservations) : 0;

    // Delete stale/cancelled reservations that are no longer in the API response
    // This ensures cancelled reservations are removed from the database
    const reservationIds = reservations.map(r => r.reservation_id);
    const deletedStaleCount = deleteStaleReservationsInRange(
      listingId,
      startDateStr,
      endDateStr,
      reservationIds
    );

    const duration = Date.now() - startTime;

    logger.info(
      {
        listingId,
        daysCount: upsertedCount,
        reservationsCount: upsertedReservationsCount,
        deletedAvailabilityCount,
        deletedReservationsCount,
        deletedStaleReservationsCount: deletedStaleCount,
        duration,
      },
      'Availability and reservations synced successfully'
    );

    return {
      success: true,
      listingId,
      daysCount: upsertedCount,
      reservationsCount: upsertedReservationsCount,
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
  let totalReservationsCount = 0;
  let hasErrors = false;
  const errors: string[] = [];
  const lastSyncedAt = new Date().toISOString();
  const allReservationIds = new Set<string>();

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

    // Fetch and upsert each chunk with delays to avoid rate limiting
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      try {
        logger.debug({ listingId, ...chunk, chunkIndex: i + 1, totalChunks: chunks.length }, 'Fetching calendar chunk');

        const guestyCalendar = await guestyClient.getCalendar(listingId, chunk.start, chunk.end);

        if (guestyCalendar && guestyCalendar.length > 0) {
          const availabilities = mapAvailabilityBatch(guestyCalendar);
          const reservations = extractReservationsFromCalendar(guestyCalendar, lastSyncedAt);

          const upsertedCount = upsertAvailabilityBatch(availabilities);
          const upsertedReservationsCount = reservations.length > 0 ? upsertReservationBatch(reservations) : 0;

          // Track reservation IDs from all chunks
          for (const reservation of reservations) {
            allReservationIds.add(reservation.reservation_id);
          }

          totalDaysCount += upsertedCount;
          totalReservationsCount += upsertedReservationsCount;

          logger.debug(
            { listingId, chunk, daysCount: upsertedCount, reservationsCount: upsertedReservationsCount },
            'Calendar chunk synced'
          );
        }

        // Add delay between chunks to avoid rate limiting (except after the last chunk)
        if (i < chunks.length - 1) {
          const delayMs = 1000; // 1 second delay between chunks
          logger.debug({ delayMs }, 'Delaying before next chunk to respect rate limits');
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        hasErrors = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Chunk ${chunk.start} to ${chunk.end}: ${errorMsg}`);
        logger.error({ error, listingId, chunk }, 'Failed to sync calendar chunk');

        // Continue with next chunk even if one fails
      }
    }

    // Delete old availability data and reservations
    const today_str = today.toISOString().split('T')[0];
    const deletedAvailabilityCount = deleteOldAvailability(listingId, today_str);
    const deletedReservationsCount = deleteOldReservations(listingId, today_str);

    // Delete stale/cancelled reservations across the entire synced range
    const firstChunk = chunks[0];
    const lastChunk = chunks[chunks.length - 1];
    const deletedStaleCount = deleteStaleReservationsInRange(
      listingId,
      firstChunk.start,
      lastChunk.end,
      Array.from(allReservationIds)
    );

    const duration = Date.now() - startTime;

    if (hasErrors) {
      logger.warn(
        {
          listingId,
          daysCount: totalDaysCount,
          reservationsCount: totalReservationsCount,
          deletedAvailabilityCount,
          deletedReservationsCount,
          deletedStaleReservationsCount: deletedStaleCount,
          errorCount: errors.length,
          duration,
        },
        'Availability sync completed with errors'
      );

      return {
        success: false,
        listingId,
        daysCount: totalDaysCount,
        reservationsCount: totalReservationsCount,
        partialSuccess: totalDaysCount > 0,
        error: errors.join('; '),
      };
    }

    logger.info(
      {
        listingId,
        daysCount: totalDaysCount,
        reservationsCount: totalReservationsCount,
        deletedAvailabilityCount,
        deletedReservationsCount,
        deletedStaleReservationsCount: deletedStaleCount,
        duration,
      },
      'Chunked availability and reservations synced successfully'
    );

    return {
      success: true,
      listingId,
      daysCount: totalDaysCount,
      reservationsCount: totalReservationsCount,
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
      reservationsCount: totalReservationsCount,
      partialSuccess: totalDaysCount > 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}