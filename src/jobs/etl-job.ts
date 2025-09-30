/**
 * ETL Job - Complete Sync
 *
 * Orchestrates syncing both listing and availability data.
 */

import { syncConfiguredListing } from './sync-listing.js';
import { syncConfiguredAvailability } from './sync-availability.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export interface ETLJobResult {
  success: boolean;
  listing: {
    success: boolean;
    skipped?: boolean;
    error?: string;
  };
  availability: {
    success: boolean;
    daysCount?: number;
    skipped?: boolean;
    error?: string;
  };
  duration: number;
  timestamp: string;
}

/**
 * Run complete ETL job: sync listing and availability
 */
export async function runETLJob(force: boolean = false): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  logger.info({ propertyId: config.guestyPropertyId, force }, '🚀 Starting ETL job');

  try {
    // Step 1: Sync listing data
    logger.info('Step 1/2: Syncing listing data...');
    const listingResult = await syncConfiguredListing(force);

    // Step 2: Sync availability data
    logger.info('Step 2/2: Syncing availability data...');
    const availabilityResult = await syncConfiguredAvailability(force);

    const duration = Date.now() - startTime;
    const overallSuccess = listingResult.success && availabilityResult.success;

    const result: ETLJobResult = {
      success: overallSuccess,
      listing: {
        success: listingResult.success,
        skipped: listingResult.skipped,
        error: listingResult.error,
      },
      availability: {
        success: availabilityResult.success,
        daysCount: availabilityResult.daysCount,
        skipped: availabilityResult.skipped,
        error: availabilityResult.error,
      },
      duration,
      timestamp,
    };

    if (overallSuccess) {
      logger.info(
        {
          duration,
          listingSkipped: listingResult.skipped,
          availabilitySkipped: availabilityResult.skipped,
          daysCount: availabilityResult.daysCount,
        },
        '✅ ETL job completed successfully'
      );
    } else {
      logger.warn(
        {
          duration,
          listingError: listingResult.error,
          availabilityError: availabilityResult.error,
        },
        '⚠️  ETL job completed with errors'
      );
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        error,
        duration,
      },
      '❌ ETL job failed'
    );

    return {
      success: false,
      listing: {
        success: false,
        error: 'Job failed before listing sync',
      },
      availability: {
        success: false,
        error: 'Job failed before availability sync',
      },
      duration,
      timestamp,
    };
  }
}