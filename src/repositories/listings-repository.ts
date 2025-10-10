/**
 * Listings Repository
 *
 * Database operations for listings table.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { Listing, ListingRow } from '../types/models.js';
import { rowToListing } from '../types/models.js';

/**
 * Insert or update a listing
 */
export function upsertListing(listing: Omit<Listing, 'created_at' | 'updated_at'>): void {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO listings (
        id, title, accommodates, bedrooms, bathrooms, property_type, timezone,
        currency, base_price, weekend_base_price, cleaning_fee, extra_person_fee,
        guests_included, weekly_price_factor, monthly_price_factor, taxes,
        min_nights, max_nights, check_in_time, check_out_time, active, last_synced_at
      ) VALUES (
        @id, @title, @accommodates, @bedrooms, @bathrooms, @property_type, @timezone,
        @currency, @base_price, @weekend_base_price, @cleaning_fee, @extra_person_fee,
        @guests_included, @weekly_price_factor, @monthly_price_factor, @taxes,
        @min_nights, @max_nights, @check_in_time, @check_out_time, @active, @last_synced_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        accommodates = excluded.accommodates,
        bedrooms = excluded.bedrooms,
        bathrooms = excluded.bathrooms,
        property_type = excluded.property_type,
        timezone = excluded.timezone,
        currency = excluded.currency,
        base_price = excluded.base_price,
        weekend_base_price = excluded.weekend_base_price,
        cleaning_fee = excluded.cleaning_fee,
        extra_person_fee = excluded.extra_person_fee,
        guests_included = excluded.guests_included,
        weekly_price_factor = excluded.weekly_price_factor,
        monthly_price_factor = excluded.monthly_price_factor,
        taxes = excluded.taxes,
        min_nights = excluded.min_nights,
        max_nights = excluded.max_nights,
        check_in_time = excluded.check_in_time,
        check_out_time = excluded.check_out_time,
        active = excluded.active,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    stmt.run({
      id: listing.id,
      title: listing.title,
      accommodates: listing.accommodates,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      property_type: listing.property_type,
      timezone: listing.timezone,
      currency: listing.currency,
      base_price: listing.base_price,
      weekend_base_price: listing.weekend_base_price,
      cleaning_fee: listing.cleaning_fee,
      extra_person_fee: listing.extra_person_fee,
      guests_included: listing.guests_included,
      weekly_price_factor: listing.weekly_price_factor,
      monthly_price_factor: listing.monthly_price_factor,
      taxes: JSON.stringify(listing.taxes),
      min_nights: listing.min_nights,
      max_nights: listing.max_nights,
      check_in_time: listing.check_in_time,
      check_out_time: listing.check_out_time,
      active: listing.active ? 1 : 0,
      last_synced_at: listing.last_synced_at,
    });

    logger.debug({ listingId: listing.id }, 'Listing upserted successfully');
  } catch (error) {
    logger.error({ error, listingId: listing.id }, 'Failed to upsert listing');
    throw new DatabaseError(`Failed to upsert listing: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get listing by ID
 */
export function getListingById(id: string): Listing | null {
  const db = getDatabase();

  try {
    const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined;

    if (!row) {
      return null;
    }

    return rowToListing(row);
  } catch (error) {
    logger.error({ error, listingId: id }, 'Failed to get listing');
    throw new DatabaseError(`Failed to get listing: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get all active listings
 */
export function getActiveListings(): Listing[] {
  const db = getDatabase();

  try {
    const rows = db.prepare('SELECT * FROM listings WHERE active = 1').all() as ListingRow[];

    return rows.map(rowToListing);
  } catch (error) {
    logger.error({ error }, 'Failed to get active listings');
    throw new DatabaseError(`Failed to get active listings: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if listing needs refresh (last_synced_at is older than TTL)
 */
export function needsRefresh(listingId: string, ttlMinutes: number = 1440): boolean {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `SELECT
          CASE
            WHEN datetime(last_synced_at) < datetime('now', '-' || ? || ' minutes') THEN 1
            ELSE 0
          END as needs_refresh
         FROM listings
         WHERE id = ?`
      )
      .get(ttlMinutes, listingId) as { needs_refresh: number } | undefined;

    // If listing doesn't exist, it needs refresh
    if (!result) {
      return true;
    }

    return result.needs_refresh === 1;
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to check if listing needs refresh');
    // If error, assume it needs refresh
    return true;
  }
}