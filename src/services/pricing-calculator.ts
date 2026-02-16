/**
 * Pricing Calculator Service
 *
 * Computes complete price quotes using cached listing and availability data.
 */

import { getListingById } from '../repositories/listings-repository.js';
import { getAvailability, areDatesAvailable } from '../repositories/availability-repository.js';
import { guestyClient } from './guesty-client.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { Listing, Tax, PriceBreakdown } from '../types/models.js';

export interface QuoteRequest {
  listingId: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
}

export interface PromotionInfo {
  name: string;
  type: string;
  discountPercent: number;
  savings: number;
}

export interface QuoteResult {
  listingId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  nights: number;
  currency: string;
  accommodationFare: number;
  cleaningFee: number;
  extraGuestFee: number;
  subtotal: number;
  totalTaxes: number;
  totalPrice: number;
  discountApplied: 'weekly' | 'monthly' | null;
  discountFactor: number | null;
  discountSavings: number | null;
  promotions: PromotionInfo[];
  breakdown: PriceBreakdown;
}

/**
 * Calculate number of nights between check-in and check-out
 */
function calculateNights(checkIn: string, checkOut: string): number {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const diffTime = checkOutDate.getTime() - checkInDate.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

/**
 * Determine if date is a weekend (Friday or Saturday)
 */
function isWeekend(date: string): boolean {
  const d = new Date(date);
  const day = d.getDay();
  return day === 5 || day === 6; // Friday = 5, Saturday = 6
}

/**
 * Get discount factor based on length of stay
 */
function getDiscountFactor(nights: number, listing: Listing): { factor: number; type: 'weekly' | 'monthly' | null } {
  if (nights >= 28 && listing.monthly_price_factor < 1) {
    return { factor: listing.monthly_price_factor, type: 'monthly' };
  }
  if (nights >= 7 && listing.weekly_price_factor < 1) {
    return { factor: listing.weekly_price_factor, type: 'weekly' };
  }
  return { factor: 1.0, type: null };
}

/**
 * Calculate accommodation fare (nightly rates × discount)
 */
function calculateAccommodationFare(
  checkIn: string,
  checkOut: string,
  listing: Listing
): {
  total: number;
  baseTotal: number;
  nightlyRates: Array<{ date: string; basePrice: number; adjustedPrice: number; note?: string }>;
} {
  const nights = calculateNights(checkIn, checkOut);
  const nightlyRates: Array<{ date: string; basePrice: number; adjustedPrice: number; note?: string }> = [];

  // Get availability data for the date range
  const availability = getAvailability(listing.id, checkIn, checkOut);

  // Build map of date -> price from availability
  const priceMap = new Map<string, number>();
  availability.forEach((day) => {
    priceMap.set(day.date, day.price);
  });

  // Calculate nightly rates
  const checkInDate = new Date(checkIn);
  let baseTotal = 0;

  for (let i = 0; i < nights; i++) {
    const currentDate = new Date(checkInDate);
    currentDate.setDate(currentDate.getDate() + i);
    const dateStr = currentDate.toISOString().split('T')[0];

    // Get price from availability data, fallback to base price
    let basePrice = priceMap.get(dateStr) || listing.base_price;

    // Apply weekend pricing if configured
    if (listing.weekend_base_price && isWeekend(dateStr)) {
      basePrice = listing.weekend_base_price;
    }

    nightlyRates.push({
      date: dateStr,
      basePrice,
      adjustedPrice: basePrice, // Will be adjusted with discount later
      note: isWeekend(dateStr) && listing.weekend_base_price ? 'Weekend rate' : undefined,
    });

    baseTotal += basePrice;
  }

  // Apply discount
  const { factor, type } = getDiscountFactor(nights, listing);
  const total = baseTotal * factor;

  // Update adjusted prices
  nightlyRates.forEach((rate) => {
    rate.adjustedPrice = rate.basePrice * factor;
    if (type) {
      rate.note = rate.note ? `${rate.note}, ${type} discount` : `${type} discount`;
    }
  });

  return { total, baseTotal, nightlyRates };
}

/**
 * Calculate extra guest fee (per night)
 */
function calculateExtraGuestFee(guests: number, nights: number, listing: Listing): number {
  const extraGuests = Math.max(0, guests - listing.guests_included);
  return extraGuests * listing.extra_person_fee * nights;
}

/**
 * Calculate taxes based on listing tax rules
 */
function calculateTaxes(
  accommodationFare: number,
  cleaningFee: number,
  extraGuestFee: number,
  guests: number,
  nights: number,
  taxes: Tax[]
): { total: number; breakdown: Array<{ type: string; amount: number; description: string; calculation?: string }> } {
  let totalTaxes = 0;
  const breakdown: Array<{ type: string; amount: number; description: string; calculation?: string }> = [];

  for (const tax of taxes) {
    let taxableAmount = 0;
    let taxAmount = 0;

    // Determine taxable amount based on appliedOnFees
    if (tax.appliedToAllFees) {
      taxableAmount = accommodationFare + cleaningFee + extraGuestFee;
    } else {
      if (tax.appliedOnFees.includes('AF')) {
        taxableAmount += accommodationFare;
      }
      if (tax.appliedOnFees.includes('CF') || tax.appliedOnFees.includes('CLEANING')) {
        taxableAmount += cleaningFee;
      }
      // Note: Extra guest fee is not typically in appliedOnFees, but could be added
    }

    // Calculate tax based on units and quantifier
    if (tax.units === 'PERCENTAGE') {
      taxAmount = taxableAmount * (tax.amount / 100);
    } else if (tax.units === 'FIXED') {
      if (tax.quantifier === 'PER_NIGHT') {
        taxAmount = tax.amount * nights;
      } else if (tax.quantifier === 'PER_STAY') {
        taxAmount = tax.amount;
      } else if (tax.quantifier === 'PER_GUEST') {
        taxAmount = tax.amount * guests;
      } else if (tax.quantifier === 'PER_GUEST_PER_NIGHT') {
        taxAmount = tax.amount * guests * nights;
      }
    }

    totalTaxes += taxAmount;

    // Build description
    let description = '';
    if (tax.units === 'PERCENTAGE') {
      description = `${tax.type} ${tax.amount}%`;
    } else {
      description = `${tax.type} ${tax.amount} per ${tax.quantifier.toLowerCase().replace('_', ' ')}`;
    }

    let calculation: string | undefined;
    if (tax.units === 'PERCENTAGE') {
      calculation = `${taxableAmount.toFixed(2)} × ${tax.amount}% = ${taxAmount.toFixed(2)}`;
    } else if (tax.quantifier === 'PER_GUEST_PER_NIGHT') {
      calculation = `${tax.amount} × ${guests} guests × ${nights} nights = ${taxAmount.toFixed(2)}`;
    } else if (tax.quantifier === 'PER_NIGHT') {
      calculation = `${tax.amount} × ${nights} nights = ${taxAmount.toFixed(2)}`;
    } else if (tax.quantifier === 'PER_GUEST') {
      calculation = `${tax.amount} × ${guests} guests = ${taxAmount.toFixed(2)}`;
    }

    breakdown.push({
      type: tax.type,
      amount: taxAmount,
      description,
      calculation,
    });
  }

  return { total: totalTaxes, breakdown };
}

/**
 * Calculate complete price quote
 */
export function calculateQuote(request: QuoteRequest): QuoteResult {
  const { listingId, checkIn, checkOut, guests } = request;

  logger.debug({ listingId, checkIn, checkOut, guests }, 'Calculating price quote');

  // Get listing data
  const listing = getListingById(listingId);
  if (!listing) {
    throw new NotFoundError('Listing not found. Please run data sync first.');
  }

  // Validate dates
  const nights = calculateNights(checkIn, checkOut);
  if (nights < 1) {
    throw new ValidationError('Check-out must be after check-in');
  }

  // Validate min/max nights
  if (nights < listing.min_nights) {
    throw new ValidationError(`Minimum stay is ${listing.min_nights} night${listing.min_nights > 1 ? 's' : ''}`);
  }
  if (listing.max_nights && nights > listing.max_nights) {
    throw new ValidationError(`Maximum stay is ${listing.max_nights} nights`);
  }

  // Validate guest count
  if (guests < 1) {
    throw new ValidationError('At least 1 guest is required');
  }
  if (guests > listing.accommodates) {
    throw new ValidationError(`Property accommodates maximum ${listing.accommodates} guests`);
  }

  // Check availability
  const allAvailable = areDatesAvailable(listingId, checkIn, checkOut);
  if (!allAvailable) {
    throw new ValidationError('Selected dates are not available');
  }

  // Calculate accommodation fare
  const { total: accommodationFare, baseTotal, nightlyRates } = calculateAccommodationFare(checkIn, checkOut, listing);

  // Calculate fees
  const cleaningFee = listing.cleaning_fee;
  const extraGuestFee = calculateExtraGuestFee(guests, nights, listing);

  // Calculate subtotal
  const subtotal = accommodationFare + cleaningFee + extraGuestFee;

  // Calculate taxes
  const { total: totalTaxes, breakdown: taxBreakdown } = calculateTaxes(
    accommodationFare,
    cleaningFee,
    extraGuestFee,
    guests,
    nights,
    listing.taxes
  );

  // Calculate total
  const totalPrice = subtotal + totalTaxes;

  // Discount info
  const { factor, type } = getDiscountFactor(nights, listing);
  const discountSavings = type ? baseTotal - accommodationFare : null;

  // Build detailed breakdown
  const breakdown: PriceBreakdown = {
    nightlyRates,
    accommodationFare,
    fees: {
      cleaning: cleaningFee,
      extraGuest: extraGuestFee,
    },
    taxes: taxBreakdown,
    subtotal,
    totalTaxes,
    total: totalPrice,
  };

  logger.debug(
    {
      listingId,
      checkIn,
      checkOut,
      guests,
      nights,
      totalPrice,
      discountApplied: type,
    },
    'Quote calculated successfully'
  );

  return {
    listingId,
    checkIn,
    checkOut,
    guests,
    nights,
    currency: listing.currency,
    accommodationFare,
    cleaningFee,
    extraGuestFee,
    subtotal,
    totalTaxes,
    totalPrice,
    discountApplied: type,
    discountFactor: type ? factor : null,
    discountSavings,
    promotions: [],
    breakdown,
  };
}

/**
 * Calculate quote using Guesty API (includes promotions), with local fallback
 */
export async function calculateQuoteWithGuesty(request: QuoteRequest): Promise<QuoteResult> {
  const { listingId, checkIn, checkOut, guests } = request;

  try {
    logger.debug({ listingId, checkIn, checkOut, guests }, 'Fetching Guesty API quote');

    const guestyQuote = await guestyClient.getQuote(listingId, checkIn, checkOut, guests);

    const nights = calculateNights(checkIn, checkOut);

    // Get listing for currency and discount info
    const listing = getListingById(listingId);
    const currency = listing?.currency || 'EUR';

    // Determine discount from local listing data (Guesty doesn't expose this separately)
    const { factor, type } = listing ? getDiscountFactor(nights, listing) : { factor: 1.0, type: null as 'weekly' | 'monthly' | null };

    // Calculate discount savings from local calculation
    // Use fareAccommodationBase (excludes extra guest fee) since baseTotal is pure accommodation
    let discountSavings: number | null = null;
    if (type && listing) {
      const availability = getAvailability(listing.id, checkIn, checkOut);
      const priceMap = new Map<string, number>();
      availability.forEach((day) => priceMap.set(day.date, day.price));

      let baseTotal = 0;
      const checkInDate = new Date(checkIn);
      for (let i = 0; i < nights; i++) {
        const currentDate = new Date(checkInDate);
        currentDate.setDate(currentDate.getDate() + i);
        const dateStr = currentDate.toISOString().split('T')[0];
        baseTotal += priceMap.get(dateStr) || listing.base_price;
      }
      discountSavings = baseTotal - guestyQuote.fareAccommodationBase;
      if (discountSavings < 0) discountSavings = null;
    }

    // Build promotions from Guesty response
    const promotions: PromotionInfo[] = guestyQuote.promotions
      .filter(p => p.savings > 0)
      .map(p => ({
        name: p.name,
        type: p.type,
        discountPercent: p.discountAmount,
        savings: p.savings,
      }));

    // Use adjusted accommodation (after promotions)
    // Guesty bundles extra guest fee into fareAccommodation, so we split it out for display
    const accommodationFare = guestyQuote.fareAccommodationAdjusted;
    const cleaningFee = guestyQuote.fareCleaning;
    const extraGuestFee = guestyQuote.extraGuestFee;
    const totalTaxes = guestyQuote.totalTaxes;
    const subtotal = accommodationFare + cleaningFee + extraGuestFee;
    const totalPrice = guestyQuote.hostPayout;

    // Build breakdown from Guesty data
    const nightlyRates = guestyQuote.nightlyRates.map(nr => ({
      date: nr.date,
      basePrice: nr.basePrice,
      adjustedPrice: nr.price,
    }));

    const taxBreakdown = guestyQuote.taxes.map(t => ({
      type: t.type,
      amount: t.amount,
      description: `${t.name} ${t.units === 'PERCENTAGE' ? `${t.amount}%` : ''}`.trim(),
    }));

    const breakdown: PriceBreakdown = {
      nightlyRates,
      accommodationFare,
      fees: {
        cleaning: cleaningFee,
        extraGuest: extraGuestFee,
      },
      taxes: taxBreakdown,
      subtotal,
      totalTaxes,
      total: totalPrice,
    };

    logger.debug({
      listingId,
      totalPrice,
      promotionCount: promotions.length,
      promotionSavings: promotions.reduce((sum, p) => sum + p.savings, 0),
    }, 'Guesty API quote calculated successfully');

    return {
      listingId,
      checkIn,
      checkOut,
      guests,
      nights,
      currency,
      accommodationFare,
      cleaningFee,
      extraGuestFee,
      subtotal,
      totalTaxes,
      totalPrice,
      discountApplied: type,
      discountFactor: type ? factor : null,
      discountSavings,
      promotions,
      breakdown,
    };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : error, listingId, checkIn, checkOut },
      'Guesty API quote failed, falling back to local calculator'
    );

    return calculateQuote(request);
  }
}