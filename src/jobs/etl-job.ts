/**
 * ETL Job - Complete Sync
 *
 * Orchestrates syncing both listing and availability data.
 */

import { syncConfiguredListing } from './sync-listing.js';
import { syncConfiguredAvailability } from './sync-availability.js';
import { syncInquiries } from './sync-inquiries.js';
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
  inquiries: {
    success: boolean;
    inquiriesCount?: number;
    confirmedCount?: number;
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
    logger.info('Step 1/3: Syncing listing data...');
    const listingResult = await syncConfiguredListing(force);

    // Step 2: Sync availability data
    logger.info('Step 2/3: Syncing availability data...');
    const availabilityResult = await syncConfiguredAvailability(force);

    // Step 3: Sync inquiries data
    logger.info('Step 3/3: Syncing inquiries data...');
    const inquiriesResult = await syncInquiries(config.guestyPropertyId);

    const duration = Date.now() - startTime;
    const overallSuccess = listingResult.success && availabilityResult.success && inquiriesResult.success;

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
      inquiries: {
        success: inquiriesResult.success,
        inquiriesCount: inquiriesResult.inquiriesCount,
        confirmedCount: inquiriesResult.confirmedCount,
        error: inquiriesResult.error,
      },
      duration,
      timestamp,
    };

    if (overallSuccess) {
      logger.info(
        {
          duration,
          listingUpserted: listingResult.skipped ? 0 : 1,
          listingSkipped: listingResult.skipped || false,
          availabilityRowsUpserted: availabilityResult.daysCount || 0,
          availabilitySkipped: availabilityResult.skipped || false,
          inquiriesSynced: inquiriesResult.inquiriesCount || 0,
          confirmedSynced: inquiriesResult.confirmedCount || 0,
        },
        '✅ ETL job completed successfully'
      );
    } else {
      logger.warn(
        {
          duration,
          listingUpserted: listingResult.success && !listingResult.skipped ? 1 : 0,
          availabilityRowsUpserted: availabilityResult.daysCount || 0,
          inquiriesSynced: inquiriesResult.inquiriesCount || 0,
          listingError: listingResult.error,
          availabilityError: availabilityResult.error,
          inquiriesError: inquiriesResult.error,
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
      inquiries: {
        success: false,
        error: 'Job failed before inquiries sync',
      },
      duration,
      timestamp,
    };
  }
}