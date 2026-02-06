/**
 * ETL Job - Complete Sync
 *
 * Orchestrates syncing both listing and availability data.
 * Supports multi-property mode when properties.json is configured.
 */

import { syncListing } from './sync-listing.js';
import { syncAvailability } from './sync-availability.js';
import { syncInquiries } from './sync-inquiries.js';
import { config } from '../config/index.js';
import { getAllProperties, getDefaultProperty, type PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export interface ETLJobResult {
  success: boolean;
  propertySlug?: string;
  propertyName?: string;
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

export interface MultiPropertyETLResult {
  success: boolean;
  results: Record<string, ETLJobResult>;
  totalDuration: number;
  timestamp: string;
}

/**
 * Run ETL job for a single property
 */
export async function runETLJobForProperty(
  property: PropertyConfig,
  force: boolean = false
): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const { slug, guestyPropertyId, name } = property;

  logger.info({ propertySlug: slug, propertyId: guestyPropertyId, force }, `🚀 Starting ETL job for ${name}`);

  try {
    // Step 1: Sync listing data
    logger.info({ propertySlug: slug }, 'Step 1/3: Syncing listing data...');
    const listingResult = await syncListing(guestyPropertyId, force);

    // Step 2: Sync availability data
    logger.info({ propertySlug: slug }, 'Step 2/3: Syncing availability data...');
    const availabilityResult = await syncAvailability(guestyPropertyId, force);

    // Step 3: Sync inquiries data
    logger.info({ propertySlug: slug }, 'Step 3/3: Syncing inquiries data...');
    const inquiriesResult = await syncInquiries(guestyPropertyId);

    const duration = Date.now() - startTime;
    const overallSuccess = listingResult.success && availabilityResult.success && inquiriesResult.success;

    const result: ETLJobResult = {
      success: overallSuccess,
      propertySlug: slug,
      propertyName: name,
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
          propertySlug: slug,
          duration,
          listingUpserted: listingResult.skipped ? 0 : 1,
          listingSkipped: listingResult.skipped || false,
          availabilityRowsUpserted: availabilityResult.daysCount || 0,
          availabilitySkipped: availabilityResult.skipped || false,
          inquiriesSynced: inquiriesResult.inquiriesCount || 0,
          confirmedSynced: inquiriesResult.confirmedCount || 0,
        },
        `✅ ETL job completed successfully for ${name}`
      );
    } else {
      logger.warn(
        {
          propertySlug: slug,
          duration,
          listingUpserted: listingResult.success && !listingResult.skipped ? 1 : 0,
          availabilityRowsUpserted: availabilityResult.daysCount || 0,
          inquiriesSynced: inquiriesResult.inquiriesCount || 0,
          listingError: listingResult.error,
          availabilityError: availabilityResult.error,
          inquiriesError: inquiriesResult.error,
        },
        `⚠️  ETL job completed with errors for ${name}`
      );
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        error,
        propertySlug: slug,
        duration,
      },
      `❌ ETL job failed for ${name}`
    );

    return {
      success: false,
      propertySlug: slug,
      propertyName: name,
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

/**
 * Run complete ETL job for all configured properties
 * Falls back to single property mode if no properties.json configured
 */
export async function runETLJob(force: boolean = false): Promise<ETLJobResult> {
  const properties = getAllProperties();

  // Multi-property mode
  if (properties.length > 0) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    let overallSuccess = true;
    let totalListingUpserted = 0;
    let totalAvailabilityRows = 0;
    let totalInquiries = 0;
    let totalConfirmed = 0;

    logger.info({ propertyCount: properties.length, force }, '🚀 Starting multi-property ETL job');

    for (const property of properties) {
      const result = await runETLJobForProperty(property, force);
      if (!result.success) {
        overallSuccess = false;
      }
      if (!result.listing.skipped) totalListingUpserted++;
      totalAvailabilityRows += result.availability.daysCount || 0;
      totalInquiries += result.inquiries.inquiriesCount || 0;
      totalConfirmed += result.inquiries.confirmedCount || 0;
    }

    const totalDuration = Date.now() - startTime;

    logger.info(
      {
        propertyCount: properties.length,
        totalDuration,
        totalListingUpserted,
        totalAvailabilityRows,
        totalInquiries,
        totalConfirmed,
      },
      overallSuccess ? '✅ Multi-property ETL job completed successfully' : '⚠️  Multi-property ETL job completed with errors'
    );

    // Return result for last property (for backward compatibility)
    // The scheduler uses the overall success flag
    const lastProperty = properties[properties.length - 1];
    return {
      success: overallSuccess,
      propertySlug: lastProperty.slug,
      propertyName: lastProperty.name,
      listing: { success: overallSuccess },
      availability: { success: overallSuccess, daysCount: totalAvailabilityRows },
      inquiries: { success: overallSuccess, inquiriesCount: totalInquiries, confirmedCount: totalConfirmed },
      duration: totalDuration,
      timestamp,
    };
  }

  // Legacy single-property mode (fallback to config.guestyPropertyId)
  if (config.guestyPropertyId) {
    const defaultProperty = getDefaultProperty();
    if (defaultProperty) {
      return runETLJobForProperty(defaultProperty, force);
    }

    // Fallback: create a minimal property config from environment
    const legacyProperty: PropertyConfig = {
      slug: 'default',
      guestyPropertyId: config.guestyPropertyId,
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
    return runETLJobForProperty(legacyProperty, force);
  }

  // No properties configured at all
  const timestamp = new Date().toISOString();
  logger.error('No properties configured. Set GUESTY_PROPERTY_ID or create properties.json');
  return {
    success: false,
    listing: { success: false, error: 'No properties configured' },
    availability: { success: false, error: 'No properties configured' },
    inquiries: { success: false, error: 'No properties configured' },
    duration: 0,
    timestamp,
  };
}