/**
 * Airbnb Sync iCal
 *
 * Fetches the property's private Airbnb iCal URL, parses events, and writes
 * 24 months (today → +24mo) of Availability rows. Past days are pruned.
 */

import { fetchAirbnbIcal } from '../../services/airbnb-mail/ical-fetcher.js';
import { parseAirbnbIcal } from '../../parsers/airbnb-mail/ical-parser.js';
import { buildAvailabilityRows } from '../../mappers/airbnb-mail/availability-mapper.js';
import {
  upsertAvailabilityBatch,
  deleteOldAvailability,
} from '../../repositories/availability-repository.js';
import { getListingById } from '../../repositories/listings-repository.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncIcalResult {
  success: boolean;
  daysCount: number;
  events: number;
  error?: string;
}

export async function syncAirbnbIcal(property: PropertyConfig): Promise<SyncIcalResult> {
  const slug = property.slug;
  const airbnbListingId = property.airbnbListingId!;
  const url = property.airbnbIcalUrl!;
  try {
    logger.info({ slug, airbnbListingId }, 'Airbnb iCal: starting sync');
    const ics = await fetchAirbnbIcal(url);
    const events = parseAirbnbIcal(ics);

    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 24);
    const startStr = now.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const listing = getListingById(airbnbListingId);
    const basePrice = listing?.base_price ?? 0;
    const minNights = listing?.min_nights ?? 1;

    const rows = buildAvailabilityRows({
      listingId: airbnbListingId,
      windowStart: startStr,
      windowEnd: endStr,
      events,
      basePrice,
      defaultMinNights: minNights,
      lastSyncedAt: new Date().toISOString(),
    });
    upsertAvailabilityBatch(rows);
    const deleted = deleteOldAvailability(airbnbListingId, startStr);

    logger.info({ slug, daysCount: rows.length, events: events.length, deletedOld: deleted }, 'Airbnb iCal: sync completed');
    return { success: true, daysCount: rows.length, events: events.length };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb iCal sync failed');
    return {
      success: false,
      daysCount: 0,
      events: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
