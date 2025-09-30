/**
 * Quotes Repository
 *
 * Database operations for quotes_cache table.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { QuoteCache, QuoteCacheRow } from '../types/models.js';
import { rowToQuoteCache } from '../types/models.js';

/**
 * Get cached quote by parameters
 */
export function getCachedQuote(
  listingId: string,
  checkIn: string,
  checkOut: string,
  guests: number
): QuoteCache | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare(
        `SELECT * FROM quotes_cache
         WHERE listing_id = ?
         AND check_in = ?
         AND check_out = ?
         AND guests = ?
         AND datetime(expires_at) > datetime('now')
         LIMIT 1`
      )
      .get(listingId, checkIn, checkOut, guests) as QuoteCacheRow | undefined;

    if (!row) {
      return null;
    }

    return rowToQuoteCache(row);
  } catch (error) {
    logger.error({ error, listingId, checkIn, checkOut, guests }, 'Failed to get cached quote');
    throw new DatabaseError(`Failed to get cached quote: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Save quote to cache
 */
export function saveQuoteToCache(quote: Omit<QuoteCache, 'id' | 'created_at'>): void {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO quotes_cache (
        listing_id, check_in, check_out, guests, nights, currency,
        accommodation_fare, cleaning_fee, extra_guest_fee, subtotal,
        total_taxes, total_price, discount_applied, discount_factor,
        discount_savings, breakdown, expires_at
      ) VALUES (
        @listing_id, @check_in, @check_out, @guests, @nights, @currency,
        @accommodation_fare, @cleaning_fee, @extra_guest_fee, @subtotal,
        @total_taxes, @total_price, @discount_applied, @discount_factor,
        @discount_savings, @breakdown, @expires_at
      )
    `);

    stmt.run({
      listing_id: quote.listing_id,
      check_in: quote.check_in,
      check_out: quote.check_out,
      guests: quote.guests,
      nights: quote.nights,
      currency: quote.currency,
      accommodation_fare: quote.accommodation_fare,
      cleaning_fee: quote.cleaning_fee,
      extra_guest_fee: quote.extra_guest_fee,
      subtotal: quote.subtotal,
      total_taxes: quote.total_taxes,
      total_price: quote.total_price,
      discount_applied: quote.discount_applied,
      discount_factor: quote.discount_factor,
      discount_savings: quote.discount_savings,
      breakdown: JSON.stringify(quote.breakdown),
      expires_at: quote.expires_at,
    });

    logger.debug({ listingId: quote.listing_id, checkIn: quote.check_in }, 'Quote saved to cache');
  } catch (error) {
    logger.error({ error, quote }, 'Failed to save quote to cache');
    throw new DatabaseError(`Failed to save quote to cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean up expired quotes
 */
export function cleanupExpiredQuotes(): number {
  const db = getDatabase();

  try {
    const result = db.prepare(`DELETE FROM quotes_cache WHERE datetime(expires_at) < datetime('now')`).run();

    logger.debug({ deleted: result.changes }, 'Expired quotes cleaned up');

    return result.changes;
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup expired quotes');
    throw new DatabaseError(
      `Failed to cleanup expired quotes: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}