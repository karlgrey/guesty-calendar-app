/**
 * Sync Listing Job
 *
 * Fetches listing data from Guesty API and updates the cache.
 */

import { guestyClient } from '../services/guesty-client.js';
import { upsertListing, needsRefresh } from '../repositories/listings-repository.js';
import { mapListing } from '../mappers/listing-mapper.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export interface SyncListingResult {
  success: boolean;
  listingId: string;
  title?: string;
  skipped?: boolean;
  error?: string;
}

/**
 * Sync a single listing
 */
export async function syncListing(listingId: string, force: boolean = false): Promise<SyncListingResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId, force }, 'Starting listing sync');

    // Check if refresh is needed (unless forced)
    if (!force && !needsRefresh(listingId, config.cacheListingTtl)) {
      logger.info({ listingId }, 'Listing cache is fresh, skipping sync');
      return {
        success: true,
        listingId,
        skipped: true,
      };
    }

    // Fetch listing from Guesty API
    const guestyListing = await guestyClient.getListing(listingId);

    // Map to internal model
    const listing = mapListing(guestyListing);

    // Upsert to database
    upsertListing(listing);

    const duration = Date.now() - startTime;

    logger.info(
      {
        listingId,
        title: listing.title,
        duration,
      },
      'Listing synced successfully'
    );

    return {
      success: true,
      listingId,
      title: listing.title,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        error,
        listingId,
        duration,
      },
      'Failed to sync listing'
    );

    return {
      success: false,
      listingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sync the configured property listing
 */
export async function syncConfiguredListing(force: boolean = false): Promise<SyncListingResult> {
  return syncListing(config.guestyPropertyId, force);
}