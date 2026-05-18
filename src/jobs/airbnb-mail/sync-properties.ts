/**
 * Airbnb Sync Properties
 *
 * Static-config-only: builds a Listing from properties.json `static` block
 * and upserts.
 */

import { upsertListing } from '../../repositories/listings-repository.js';
import { mapAirbnbProperty } from '../../mappers/airbnb-mail/property-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncPropertyResult {
  success: boolean;
  error?: string;
}

export async function syncAirbnbProperty(property: PropertyConfig): Promise<SyncPropertyResult> {
  const slug = property.slug;
  try {
    logger.info({ slug, airbnbListingId: property.airbnbListingId }, 'Airbnb: starting property sync');
    const listing = mapAirbnbProperty(property);
    upsertListing(listing);
    logger.info({ slug }, 'Airbnb: property sync completed');
    return { success: true };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb: property sync failed');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
