/**
 * Hostex Property Mapper
 *
 * Builds the internal Listing model from three sources, applying
 * Static-First (properties.json `static` block) → Dynamic-Fallback
 * (median from Calendar/Reservations) → final defaults.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import logger from '../../utils/logger.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { Listing, Tax } from '../../types/models.js';

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function cleaningFeeMedian(reservations: HostexReservation[]): number | null {
  const fees = reservations
    .flatMap((r) => r.rates?.details ?? [])
    .filter((d) => d.type === 'CLEANING_FEE' && d.amount > 0)
    .map((d) => d.amount);
  return median(fees);
}

function basePriceMedian(calendar: HostexCalendarDay[]): number | null {
  const prices = calendar.map((d) => d.price).filter((p) => p > 0);
  return median(prices);
}

function minNightsMedian(calendar: HostexCalendarDay[]): number | null {
  const vals = calendar.map((d) => d.restrictions.min_stay_on_arrival).filter((v) => v > 0);
  return median(vals);
}

function maxNightsMax(calendar: HostexCalendarDay[]): number | null {
  if (calendar.length === 0) return null;
  return Math.max(...calendar.map((d) => d.restrictions.max_stay_on_arrival));
}

export function mapHostexProperty(args: {
  hostexProperty: HostexProperty;
  propertyConfig: PropertyConfig;
  recentReservations: HostexReservation[];
  calendarSample: HostexCalendarDay[];
}): Omit<Listing, 'created_at' | 'updated_at'> {
  const { hostexProperty, propertyConfig, recentReservations, calendarSample } = args;
  const stat = propertyConfig.static;
  if (!stat) {
    throw new Error(
      `mapHostexProperty called without static config for property ${propertyConfig.slug}`
    );
  }

  // base_price: static → median calendar → 0
  let basePrice = stat.basePrice ?? null;
  if (basePrice == null) {
    basePrice = basePriceMedian(calendarSample);
  }
  if (basePrice == null) {
    logger.warn(
      { slug: propertyConfig.slug },
      'No basePrice available (no static, empty calendar) — using 0'
    );
    basePrice = 0;
  }

  // cleaning_fee: static → median reservations → 0
  let cleaningFee = stat.cleaningFee ?? null;
  if (cleaningFee == null) {
    cleaningFee = cleaningFeeMedian(recentReservations);
  }
  if (cleaningFee == null) cleaningFee = 0;

  // min_nights: static → median calendar → 1
  let minNights = stat.minNights ?? null;
  if (minNights == null) {
    const med = minNightsMedian(calendarSample);
    minNights = med != null ? Math.round(med) : null;
  }
  if (minNights == null) minNights = 1;

  // max_nights: static → max calendar → null
  let maxNights: number | null = stat.maxNights ?? null;
  if (maxNights == null) {
    maxNights = maxNightsMax(calendarSample);
  }

  // currency: propertyConfig → first channel → "EUR"
  const currency =
    propertyConfig.currency ?? hostexProperty.channels[0]?.currency ?? 'EUR';

  // check-in/out times: googleCalendar → hostex default → null
  const checkInTime =
    propertyConfig.googleCalendar?.checkInTime ?? hostexProperty.default_checkin_time ?? null;
  const checkOutTime =
    propertyConfig.googleCalendar?.checkOutTime ?? hostexProperty.default_checkout_time ?? null;

  // guests_included: static → accommodates
  const guestsIncluded = stat.guestsIncluded ?? stat.accommodates;

  // taxes: static → [] (cast to Tax shape with synthesized id)
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
    id: String(hostexProperty.id),
    title: hostexProperty.title,
    nickname: propertyConfig.name ?? hostexProperty.title,
    accommodates: stat.accommodates,
    bedrooms: stat.bedrooms ?? null,
    bathrooms: stat.bathrooms ?? null,
    property_type: stat.propertyType ?? null,
    timezone: hostexProperty.timezone ?? propertyConfig.timezone ?? 'Europe/Berlin',
    currency,
    base_price: basePrice,
    weekend_base_price: null,
    cleaning_fee: cleaningFee,
    extra_person_fee: stat.extraPersonFee ?? 0,
    guests_included: guestsIncluded,
    weekly_price_factor: stat.weeklyPriceFactor ?? 1.0,
    monthly_price_factor: stat.monthlyPriceFactor ?? 1.0,
    taxes,
    min_nights: minNights,
    max_nights: maxNights,
    check_in_time: checkInTime,
    check_out_time: checkOutTime,
    active: true,
    last_synced_at: new Date().toISOString(),
  };
}
