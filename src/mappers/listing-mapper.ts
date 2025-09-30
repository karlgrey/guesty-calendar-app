/**
 * Listing Mapper
 *
 * Maps Guesty API listing responses to internal database models.
 * See docs/DATA_MODEL.md for field mapping documentation.
 */

import type { GuestyListing, GuestyTax } from '../types/guesty';
import type { Listing, Tax } from '../types/models';

/**
 * Map Guesty tax to internal tax structure
 */
export function mapTax(guestyTax: GuestyTax): Tax {
  return {
    id: guestyTax._id,
    type: guestyTax.type,
    amount: guestyTax.amount,
    units: guestyTax.units,
    quantifier: guestyTax.quantifier,
    appliedToAllFees: guestyTax.appliedToAllFees || false,
    appliedOnFees: guestyTax.appliedOnFees || [],
  };
}

/**
 * Map Guesty listing to internal listing model
 */
export function mapListing(guestyListing: GuestyListing): Omit<Listing, 'created_at' | 'updated_at'> {
  const now = new Date().toISOString();

  // Map taxes
  const taxes = (guestyListing.taxes || []).map(mapTax);

  // Determine active status (both active AND listed must be true)
  const active = (guestyListing.active ?? true) && (guestyListing.listed ?? true);

  return {
    id: guestyListing._id,
    title: guestyListing.title,
    accommodates: guestyListing.accommodates,
    bedrooms: guestyListing.bedrooms ?? null,
    bathrooms: guestyListing.bathrooms ?? null,
    property_type: guestyListing.propertyType ?? null,
    timezone: guestyListing.timezone,

    // Pricing
    currency: guestyListing.prices.currency,
    base_price: guestyListing.prices.basePrice,
    weekend_base_price: guestyListing.prices.weekendBasePrice ?? null,
    cleaning_fee: guestyListing.prices.cleaningFee ?? 0,
    extra_person_fee: guestyListing.prices.extraPersonFee ?? 0,
    guests_included: guestyListing.prices.guestsIncludedInRegularFee ?? 1,

    // Discounts
    weekly_price_factor: guestyListing.prices.weeklyPriceFactor ?? 1.0,
    monthly_price_factor: guestyListing.prices.monthlyPriceFactor ?? 1.0,

    // Taxes
    taxes,

    // Terms
    min_nights: guestyListing.terms?.minNights ?? 1,
    max_nights: guestyListing.terms?.maxNights ?? null,
    check_in_time: guestyListing.terms?.checkInTime ?? null,
    check_out_time: guestyListing.terms?.checkOutTime ?? null,

    // Metadata
    active,
    last_synced_at: now,
  };
}

/**
 * Convert internal listing to database insert/update object
 * (with proper JSON serialization)
 */
export function listingToDbRow(listing: Omit<Listing, 'created_at' | 'updated_at'>) {
  return {
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
  };
}