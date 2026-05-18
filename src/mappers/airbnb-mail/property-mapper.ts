/**
 * Airbnb Property Mapper
 *
 * Builds the internal Listing model entirely from properties.json `static`
 * config. Airbnb exposes no listing metadata via Mail/iCal, so this is a
 * pure static-config mapping.
 */

import type { PropertyConfig } from '../../config/properties.js';
import type { Listing, Tax } from '../../types/models.js';

export function mapAirbnbProperty(
  propertyConfig: PropertyConfig
): Omit<Listing, 'created_at' | 'updated_at'> {
  const stat = propertyConfig.static;
  if (!stat) {
    throw new Error(
      `mapAirbnbProperty called without static config for property ${propertyConfig.slug}`
    );
  }
  if (!propertyConfig.airbnbListingId) {
    throw new Error(
      `mapAirbnbProperty: airbnbListingId missing for ${propertyConfig.slug}`
    );
  }

  const taxes: Tax[] = (stat.taxes ?? []).map((t, idx) => ({
    id: `static-${idx}`,
    type: t.type,
    amount: t.amount,
    units: t.units,
    quantifier: t.quantifier,
    appliedToAllFees: t.appliedToAllFees ?? false,
    appliedOnFees: t.appliedOnFees ?? [],
  }));

  return {
    id: propertyConfig.airbnbListingId,
    title: propertyConfig.name,
    nickname: propertyConfig.name,
    accommodates: stat.accommodates,
    bedrooms: stat.bedrooms ?? null,
    bathrooms: stat.bathrooms ?? null,
    property_type: stat.propertyType ?? null,
    timezone: propertyConfig.timezone ?? 'Europe/Berlin',
    currency: propertyConfig.currency ?? 'EUR',
    base_price: stat.basePrice ?? 0,
    weekend_base_price: null,
    cleaning_fee: stat.cleaningFee ?? 0,
    extra_person_fee: stat.extraPersonFee ?? 0,
    guests_included: stat.guestsIncluded ?? stat.accommodates,
    weekly_price_factor: stat.weeklyPriceFactor ?? 1.0,
    monthly_price_factor: stat.monthlyPriceFactor ?? 1.0,
    taxes,
    min_nights: stat.minNights ?? 1,
    max_nights: stat.maxNights ?? null,
    check_in_time: propertyConfig.googleCalendar?.checkInTime ?? null,
    check_out_time: propertyConfig.googleCalendar?.checkOutTime ?? null,
    active: true,
    last_synced_at: new Date().toISOString(),
  };
}
