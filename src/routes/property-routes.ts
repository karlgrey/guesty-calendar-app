/**
 * Property Routes
 *
 * Property-aware routes that use the slug parameter to determine which property to serve.
 * Provides /p/:slug/listing, /p/:slug/availability, /p/:slug/quote endpoints.
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { getListingById } from '../repositories/listings-repository.js';
import { getAvailability } from '../repositories/availability-repository.js';
import { calculateQuote } from '../services/pricing-calculator.js';
import { getCachedQuote, saveQuoteToCache, cleanupExpiredQuotes } from '../repositories/quotes-repository.js';
import { getPropertyBySlug, type PropertyConfig } from '../config/properties.js';
import { config } from '../config/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Extend Express Request to include resolved property
 */
declare global {
  namespace Express {
    interface Request {
      property?: PropertyConfig;
    }
  }
}

/**
 * Middleware to resolve property from slug parameter
 */
function resolveProperty(req: Request, _res: Response, next: NextFunction) {
  const { slug } = req.params;

  if (!slug) {
    return next(new ValidationError('Property slug is required'));
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    return next(new NotFoundError(`Property '${slug}' not found`));
  }

  req.property = property;
  next();
}

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
 * GET /p/:slug
 * Serve the calendar frontend for a specific property
 */
router.get('/:slug', resolveProperty, (req: Request, res: Response, next: NextFunction) => {
  try {
    const property = req.property!;
    const publicDir = path.join(process.cwd(), 'public');
    const indexPath = path.join(publicDir, 'index.html');

    // Read the HTML template
    let html = fs.readFileSync(indexPath, 'utf-8');

    // Inject property context into the HTML
    // Add a script tag to set the property slug before calendar.js loads
    const propertyScript = `<script>window.__PROPERTY_SLUG__ = "${property.slug}"; window.__PROPERTY_NAME__ = "${property.name}"; window.__BOOKING_EMAIL__ = "${property.bookingRecipientEmail}";</script>`;
    html = html.replace('</head>', `${propertyScript}\n</head>`);

    // Update the title
    html = html.replace(/<title>.*<\/title>/, `<title>Booking Calendar - ${property.name}</title>`);

    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /p/:slug/listing
 * Get listing information for a specific property
 */
router.get('/:slug/listing', resolveProperty, (req: Request, res: Response, next: NextFunction) => {
  try {
    const property = req.property!;
    const listing = getListingById(property.guestyPropertyId);

    if (!listing) {
      throw new NotFoundError('Listing not found. Please run data sync first.');
    }

    const response = {
      id: listing.id,
      title: listing.title,
      nickname: listing.nickname,
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

    logger.debug({ propertySlug: property.slug, listingId: listing.id }, 'Listing data retrieved');

    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /p/:slug/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Get availability for a specific property
 */
router.get('/:slug/availability', resolveProperty, (req: Request, res: Response, next: NextFunction) => {
  try {
    const property = req.property!;
    const { from, to } = req.query;

    if (!from || !to) {
      throw new ValidationError('Missing required parameters: from and to (YYYY-MM-DD format)');
    }

    if (!isValidDate(from as string) || !isValidDate(to as string)) {
      throw new ValidationError('Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15)');
    }

    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (fromDate > toDate) {
      throw new ValidationError('From date must be before or equal to to date');
    }

    const daysDiff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
      throw new ValidationError('Date range cannot exceed 365 days');
    }

    const availability = getAvailability(property.guestyPropertyId, from as string, to as string);

    const response = availability.map((day) => ({
      date: day.date,
      status: day.status,
      price: day.price,
      minNights: day.min_nights,
      closedToArrival: day.closed_to_arrival,
      closedToDeparture: day.closed_to_departure,
    }));

    logger.debug({ propertySlug: property.slug, from, to, count: response.length }, 'Availability data retrieved');

    res.json({
      from,
      to,
      currency: property.currency,
      days: response,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /p/:slug/quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N
 * Get price quote for a specific property
 */
router.get('/:slug/quote', resolveProperty, (req: Request, res: Response, next: NextFunction) => {
  try {
    const property = req.property!;
    const { checkIn, checkOut, guests } = req.query;

    if (!checkIn || !checkOut || !guests) {
      throw new ValidationError('Missing required parameters: checkIn, checkOut, and guests');
    }

    if (!isValidDate(checkIn as string) || !isValidDate(checkOut as string)) {
      throw new ValidationError('Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15)');
    }

    const guestCount = parseInt(guests as string, 10);
    if (isNaN(guestCount) || guestCount < 1) {
      throw new ValidationError('Guests must be a positive integer');
    }

    const listingId = property.guestyPropertyId;

    // Try to get cached quote
    const cachedQuote = getCachedQuote(listingId, checkIn as string, checkOut as string, guestCount);

    if (cachedQuote) {
      logger.debug({ propertySlug: property.slug, listingId, checkIn, checkOut, guests: guestCount }, 'Quote served from cache');

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
    logger.debug({ propertySlug: property.slug, listingId, checkIn, checkOut, guests: guestCount }, 'Cache miss, calculating fresh quote');

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

    cleanupExpiredQuotes();

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
