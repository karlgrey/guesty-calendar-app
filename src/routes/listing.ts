/**
 * Listing Routes
 *
 * Public read-only endpoint for listing information.
 */

import express from 'express';
import { getListingById } from '../repositories/listings-repository.js';
import { config } from '../config/index.js';
import { NotFoundError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /listing
 * Get listing information for the configured property
 */
router.get('/', (_req, res, next) => {
  try {
    const listing = getListingById(config.guestyPropertyId);

    if (!listing) {
      throw new NotFoundError('Listing not found. Please run data sync first.');
    }

    // Return public-facing listing info (omit internal metadata)
    const response = {
      id: listing.id,
      title: listing.title,
      accommodates: listing.accommodates,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      propertyType: listing.property_type,
      timezone: listing.timezone,
      currency: listing.currency,
      pricing: {
        basePrice: listing.base_price,
        weekendBasePrice: listing.weekend_base_price,
        cleaningFee: listing.cleaning_fee,
        extraPersonFee: listing.extra_person_fee,
        guestsIncluded: listing.guests_included,
        weeklyDiscount: listing.weekly_price_factor < 1 ? (1 - listing.weekly_price_factor) * 100 : 0,
        monthlyDiscount: listing.monthly_price_factor < 1 ? (1 - listing.monthly_price_factor) * 100 : 0,
      },
      taxes: listing.taxes,
      terms: {
        minNights: listing.min_nights,
        maxNights: listing.max_nights,
        checkInTime: listing.check_in_time,
        checkOutTime: listing.check_out_time,
      },
    };

    logger.debug({ listingId: listing.id }, 'Listing data retrieved');

    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;