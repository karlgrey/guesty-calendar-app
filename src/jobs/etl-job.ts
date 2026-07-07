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
import { syncHostexProperty } from './hostex/sync-properties.js';
import { syncHostexReservations } from './hostex/sync-reservations.js';
import { syncHostexCalendar } from './hostex/sync-calendar.js';
import { syncHostexMessagesForProperty } from './hostex/sync-hostex-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import { getHostexClient } from '../services/hostex-client.js';
import { syncVault } from '../services/vault-sync.js';
import { syncAirbnbProperty } from './airbnb-mail/sync-properties.js';
import { syncAirbnbMail } from './airbnb-mail/sync-mail.js';
import { syncAirbnbIcal } from './airbnb-mail/sync-ical.js';

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

async function runAirbnbMailETL(property: PropertyConfig, force: boolean): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const slug = property.slug;

  logger.info({ propertySlug: slug, force }, `🚀 Starting Airbnb-Mail ETL for ${property.name}`);

  // Step 1: property listing (static)
  const propertyResult = await syncAirbnbProperty(property);

  // Step 2: mail sync (reservations + inquiries)
  const mailResult = propertyResult.success
    ? await syncAirbnbMail(property)
    : { success: false, fetched: 0, parsedOk: 0, confirmedCount: 0, parsedError: 0, ignoredCount: 0, prunedArchive: 0, error: 'Skipped: property sync failed' };

  // Step 3: iCal sync (availability)
  const icalResult = propertyResult.success
    ? await syncAirbnbIcal(property)
    : { success: false, daysCount: 0, events: 0, error: 'Skipped: property sync failed' };

  const success = propertyResult.success && mailResult.success && icalResult.success;
  const duration = Date.now() - startTime;

  logger.info(
    {
      propertySlug: slug,
      duration,
      success,
      mailsFetched: mailResult.fetched,
      mailsParsedOk: mailResult.parsedOk,
      mailsParsedError: mailResult.parsedError,
      mailsIgnored: mailResult.ignoredCount,
      daysCount: icalResult.daysCount,
      icalEvents: icalResult.events,
    },
    success
      ? `✅ Airbnb-Mail ETL completed for ${property.name}`
      : `⚠️  Airbnb-Mail ETL completed with errors for ${property.name}`
  );

  return {
    success,
    propertySlug: slug,
    propertyName: property.name,
    listing: { success: propertyResult.success, error: propertyResult.error },
    availability: {
      success: icalResult.success,
      daysCount: icalResult.daysCount,
      error: icalResult.error,
    },
    inquiries: {
      success: mailResult.success,
      inquiriesCount: mailResult.parsedOk,
      confirmedCount: mailResult.confirmedCount,
      error: mailResult.error,
    },
    duration,
    timestamp,
  };
}

async function runHostexETL(property: PropertyConfig, force: boolean): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const slug = property.slug;

  logger.info({ propertySlug: slug, force }, `🚀 Starting Hostex ETL for ${property.name}`);

  // Step 1: bootstrap property listing
  const propertyResult = await syncHostexProperty(property);

  // Step 2: reservations (always run, FK on listings.id satisfied by Step 1)
  const reservationsResult = propertyResult.success
    ? await syncHostexReservations(property)
    : { success: false, inquiriesCount: 0, confirmedCount: 0, error: 'Skipped: property sync failed' };

  // Step 3: message sync (conversations → message_threads + messages)
  if (propertyResult.success) {
    try {
      await syncHostexMessagesForProperty(property, getHostexClient());
    } catch (error) {
      logger.error({ error, propertySlug: property.slug }, 'Hostex: message sync error (non-fatal)');
    }
    try {
      await generateDraftsForProperty(property);
    } catch (error) {
      logger.error({ error, propertySlug: property.slug }, 'Hostex: draft-gen error (non-fatal)');
    }
  }

  // Step 4: calendar
  const calendarResult = propertyResult.success && propertyResult.hostexProperty
    ? await syncHostexCalendar(property, propertyResult.hostexProperty)
    : { success: false, daysCount: 0, error: 'Skipped: property sync failed' };

  // Step 5 (optional re-mapping): if reservations & calendar succeeded, re-sync property
  // so the mapper sees the freshly-synced dynamic data for next-run accuracy.
  if (propertyResult.success && reservationsResult.success && calendarResult.success) {
    await syncHostexProperty(property);
  }

  const success =
    propertyResult.success && reservationsResult.success && calendarResult.success;

  const duration = Date.now() - startTime;
  logger.info(
    {
      propertySlug: slug,
      duration,
      success,
      daysCount: calendarResult.daysCount,
      inquiriesCount: reservationsResult.inquiriesCount,
      confirmedCount: reservationsResult.confirmedCount,
    },
    success
      ? `✅ Hostex ETL completed for ${property.name}`
      : `⚠️  Hostex ETL completed with errors for ${property.name}`
  );

  return {
    success,
    propertySlug: slug,
    propertyName: property.name,
    listing: { success: propertyResult.success, error: propertyResult.error },
    availability: {
      success: calendarResult.success,
      daysCount: calendarResult.daysCount,
      error: calendarResult.error,
    },
    inquiries: {
      success: reservationsResult.success,
      inquiriesCount: reservationsResult.inquiriesCount,
      confirmedCount: reservationsResult.confirmedCount,
      error: reservationsResult.error,
    },
    duration,
    timestamp,
  };
}

/**
 * Run ETL job for a single property
 */
export async function runETLJobForProperty(
  property: PropertyConfig,
  force: boolean = false
): Promise<ETLJobResult> {
  const startTime = Date.now();

  // Dispatch by provider — Hostex has its own ETL pipeline
  if (property.provider === 'hostex') {
    return runHostexETL(property, force);
  }
  if (property.provider === 'airbnb-mail') {
    return runAirbnbMailETL(property, force);
  }

  const timestamp = new Date().toISOString();
  const { slug, guestyPropertyId, name } = property;

  logger.info({ propertySlug: slug, propertyId: guestyPropertyId, force }, `🚀 Starting ETL job for ${name}`);

  try {
    // Step 1: Sync listing data
    logger.info({ propertySlug: slug }, 'Step 1/3: Syncing listing data...');
    const listingResult = await syncListing(guestyPropertyId!, force);

    // Step 2: Sync availability data
    logger.info({ propertySlug: slug }, 'Step 2/3: Syncing availability data...');
    const availabilityResult = await syncAvailability(guestyPropertyId!, force);

    // Step 3: Sync inquiries data
    logger.info({ propertySlug: slug }, 'Step 3/3: Syncing inquiries data...');
    const inquiriesResult = await syncInquiries(guestyPropertyId!);

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
  // Vault zuerst syncen: frisches Wissen für Draft-Gen + liegengebliebene Feedback-Commits pushen
  const vaultSync = syncVault();
  if (vaultSync.error) {
    logger.warn({ error: vaultSync.error }, '📚 Vault-Sync (non-fatal)');
  } else if (vaultSync.synced) {
    logger.info({ pushed: vaultSync.pushed }, '📚 Vault synced');
  }

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
      provider: 'guesty',
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