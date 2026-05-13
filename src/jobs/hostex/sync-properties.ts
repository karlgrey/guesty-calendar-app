/**
 * Hostex Sync Properties
 *
 * Fetches the property record from Hostex, reads recently-synced reservations
 * and calendar sample from DB for the dynamic-fallback layer of the mapper,
 * and upserts the listing.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { getDatabase } from '../../db/index.js';
import { upsertListing } from '../../repositories/listings-repository.js';
import { mapHostexProperty } from '../../mappers/hostex/property-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';

export interface SyncPropertyResult {
  success: boolean;
  hostexProperty?: HostexProperty;
  error?: string;
}

export async function syncHostexProperty(property: PropertyConfig): Promise<SyncPropertyResult> {
  const slug = property.slug;
  const hostexId = property.hostexPropertyId!;

  try {
    logger.info({ slug, hostexId }, 'Hostex: starting property sync');

    const client = getHostexClient();
    const allProperties = await client.getProperties();
    const hostexProperty = allProperties.find((p) => String(p.id) === hostexId);
    if (!hostexProperty) {
      throw new Error(`Hostex property ${hostexId} not found in API response`);
    }

    // Load dynamic-fallback data from DB (whatever exists from previous syncs).
    // cleaning_fee fallback would need rate details which we don't persist, so we
    // pass an empty array — cleaning_fee falls through to static config or 0.
    const recentReservations: HostexReservation[] = [];

    const db = getDatabase();
    const calendarSampleRaw = db
      .prepare(
        `SELECT price, min_nights, closed_to_arrival, closed_to_departure
         FROM availability
         WHERE listing_id = ?
         AND date(date) >= date('now')
         AND date(date) <= date('now', '+30 days')
         ORDER BY date ASC`
      )
      .all(hostexId) as Array<{
        price: number;
        min_nights: number;
        closed_to_arrival: number;
        closed_to_departure: number;
      }>;

    const calendarSample: HostexCalendarDay[] = calendarSampleRaw.map((r) => ({
      date: 'synthetic',
      price: r.price,
      inventory: 1,
      restrictions: {
        min_stay_on_arrival: r.min_nights,
        max_stay_on_arrival: 365,
        closed_on_arrival: r.closed_to_arrival === 1,
        closed_on_departure: r.closed_to_departure === 1,
      },
    }));

    const listing = mapHostexProperty({
      hostexProperty,
      propertyConfig: property,
      recentReservations,
      calendarSample,
    });

    upsertListing(listing);
    logger.info({ slug, hostexId }, 'Hostex: property sync completed');
    return { success: true, hostexProperty };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: property sync failed');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
