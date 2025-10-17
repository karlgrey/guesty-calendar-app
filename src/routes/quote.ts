/**
 * Quote Routes
 *
 * Public read-only endpoint for price quotes.
 */

import express from 'express';
import { calculateQuote } from '../services/pricing-calculator.js';
import { getCachedQuote, saveQuoteToCache, cleanupExpiredQuotes } from '../repositories/quotes-repository.js';
import { config } from '../config/index.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) {
    return false;
  }
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * GET /quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N
 * Get price quote with complete breakdown
 */
router.get('/', (req, res, next) => {
  try {
    const { checkIn, checkOut, guests } = req.query;

    // Validate required parameters
    if (!checkIn || !checkOut || !guests) {
      throw new ValidationError('Missing required parameters: checkIn, checkOut, and guests');
    }

    // Validate date format
    if (!isValidDate(checkIn as string) || !isValidDate(checkOut as string)) {
      throw new ValidationError('Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15)');
    }

    // Validate guest count
    const guestCount = parseInt(guests as string, 10);
    if (isNaN(guestCount) || guestCount < 1) {
      throw new ValidationError('Guests must be a positive integer');
    }

    const listingId = config.guestyPropertyId;

    // Try to get cached quote
    let cachedQuote = getCachedQuote(listingId, checkIn as string, checkOut as string, guestCount);

    if (cachedQuote) {
      logger.debug({ listingId, checkIn, checkOut, guests: guestCount }, 'Quote served from cache');

      return res.json({
        cached: true,
        quote: {
          checkIn: cachedQuote.check_in,
          checkOut: cachedQuote.check_out,
          guests: cachedQuote.guests,
          nights: cachedQuote.nights,
          currency: cachedQuote.currency,
          pricing: {
            accommodationFare: cachedQuote.accommodation_fare,
            cleaningFee: cachedQuote.cleaning_fee,
            extraGuestFee: cachedQuote.extra_guest_fee,
            subtotal: cachedQuote.subtotal,
            totalTaxes: cachedQuote.total_taxes,
            totalPrice: cachedQuote.total_price,
          },
          discount: cachedQuote.discount_applied
            ? {
                type: cachedQuote.discount_applied,
                factor: cachedQuote.discount_factor,
                savings: cachedQuote.discount_savings,
              }
            : null,
          breakdown: cachedQuote.breakdown,
        },
      });
    }

    // Cache miss - calculate fresh quote
    logger.debug({ listingId, checkIn, checkOut, guests: guestCount }, 'Cache miss, calculating fresh quote');

    const quote = calculateQuote({
      listingId,
      checkIn: checkIn as string,
      checkOut: checkOut as string,
      guests: guestCount,
    });

    // Save to cache
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + config.cacheQuoteTtl);

    saveQuoteToCache({
      listing_id: quote.listingId,
      check_in: quote.checkIn,
      check_out: quote.checkOut,
      guests: quote.guests,
      nights: quote.nights,
      currency: quote.currency,
      accommodation_fare: quote.accommodationFare,
      cleaning_fee: quote.cleaningFee,
      extra_guest_fee: quote.extraGuestFee,
      subtotal: quote.subtotal,
      total_taxes: quote.totalTaxes,
      total_price: quote.totalPrice,
      discount_applied: quote.discountApplied,
      discount_factor: quote.discountFactor,
      discount_savings: quote.discountSavings,
      breakdown: quote.breakdown,
      expires_at: expiresAt.toISOString(),
    });

    // Clean up expired quotes (opportunistic cleanup)
    cleanupExpiredQuotes();

    // Return quote
    res.json({
      cached: false,
      quote: {
        checkIn: quote.checkIn,
        checkOut: quote.checkOut,
        guests: quote.guests,
        nights: quote.nights,
        currency: quote.currency,
        pricing: {
          accommodationFare: quote.accommodationFare,
          cleaningFee: quote.cleaningFee,
          extraGuestFee: quote.extraGuestFee,
          subtotal: quote.subtotal,
          totalTaxes: quote.totalTaxes,
          totalPrice: quote.totalPrice,
        },
        discount: quote.discountApplied
          ? {
              type: quote.discountApplied,
              factor: quote.discountFactor,
              savings: quote.discountSavings,
            }
          : null,
        breakdown: quote.breakdown,
      },
    });
    return;
  } catch (error) {
    return next(error);
  }
});

export default router;