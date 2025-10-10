/**
 * Internal Data Model Type Definitions
 *
 * These types represent the internal SQLite database schema.
 * See docs/DATA_MODEL.md for detailed documentation.
 */

// ============================================================================
// DATABASE MODELS
// ============================================================================

/**
 * Tax configuration from Guesty API (simplified for storage)
 */
export interface Tax {
  id: string;
  type: string; // 'LOCAL_TAX', 'CITY_TAX', 'VAT', etc.
  amount: number;
  units: 'PERCENTAGE' | 'FIXED';
  quantifier: 'PER_NIGHT' | 'PER_STAY' | 'PER_GUEST' | 'PER_GUEST_PER_NIGHT';
  appliedToAllFees: boolean;
  appliedOnFees: string[]; // Fee codes like 'AF', 'CF', 'CLEANING'
}

/**
 * Listing (property) details
 */
export interface Listing {
  id: string; // Guesty listing ID
  title: string;
  nickname: string | null; // Display name (optional, falls back to title)
  accommodates: number; // Max guests
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  timezone: string; // IANA timezone (e.g., 'Europe/Berlin')

  // Pricing
  currency: string; // ISO 4217 code (EUR, USD, etc.)
  base_price: number; // Base nightly rate
  weekend_base_price: number | null; // Weekend rate (optional)
  cleaning_fee: number;
  extra_person_fee: number;
  guests_included: number;

  // Discounts (stored as factors: 0.90 = 10% off)
  weekly_price_factor: number;
  monthly_price_factor: number;

  // Taxes (stored as JSON array)
  taxes: Tax[];

  // Terms
  min_nights: number;
  max_nights: number | null;
  check_in_time: string | null; // e.g., '16:00'
  check_out_time: string | null; // e.g., '11:00'

  // Metadata
  active: boolean;
  last_synced_at: string; // ISO 8601 timestamp (UTC)
  created_at: string;
  updated_at: string;
}

/**
 * Daily availability status
 */
export type AvailabilityStatus = 'available' | 'blocked' | 'booked';

/**
 * Block type for unavailable dates
 */
export type BlockType = 'reservation' | 'owner' | 'manual' | 'maintenance' | null;

/**
 * Daily availability and pricing
 */
export interface Availability {
  id: number;
  listing_id: string;
  date: string; // ISO 8601 date (YYYY-MM-DD) in property timezone
  status: AvailabilityStatus;
  price: number; // Nightly rate for this date
  min_nights: number;

  // Restrictions
  closed_to_arrival: boolean; // CTA: cannot check in on this date
  closed_to_departure: boolean; // CTD: cannot check out on this date

  // Block details (optional)
  block_type: BlockType;
  block_ref: string | null; // Reference ID for the block

  // Metadata
  last_synced_at: string; // ISO 8601 timestamp (UTC)
  created_at: string;
  updated_at: string;
}

/**
 * Detailed pricing breakdown for quote
 */
export interface PriceBreakdown {
  nightlyRates: Array<{
    date: string;
    basePrice: number;
    adjustedPrice: number;
    note?: string;
  }>;
  accommodationFare: number;
  fees: {
    cleaning: number;
    extraGuest: number;
  };
  taxes: Array<{
    type: string;
    amount: number;
    description: string;
    calculation?: string;
  }>;
  subtotal: number;
  totalTaxes: number;
  total: number;
}

/**
 * Cached price quote
 */
export interface QuoteCache {
  id: number;
  listing_id: string;
  check_in: string; // ISO 8601 date (YYYY-MM-DD)
  check_out: string; // ISO 8601 date (YYYY-MM-DD)
  guests: number;

  // Pricing breakdown
  nights: number;
  currency: string;
  accommodation_fare: number; // Total for all nights (after discounts)
  cleaning_fee: number;
  extra_guest_fee: number;
  subtotal: number;
  total_taxes: number;
  total_price: number;

  // Discount info
  discount_applied: 'weekly' | 'monthly' | null;
  discount_factor: number | null; // e.g., 0.90
  discount_savings: number | null; // Amount saved

  // Full breakdown (stored as JSON)
  breakdown: PriceBreakdown;

  // Cache management
  expires_at: string; // ISO 8601 timestamp (UTC)
  created_at: string;
}

// ============================================================================
// DATABASE ROW TYPES (as returned from SQLite)
// ============================================================================

/**
 * Raw listing row from database (before JSON parsing)
 */
export interface ListingRow {
  id: string;
  title: string;
  nickname: string | null;
  accommodates: number;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  timezone: string;
  currency: string;
  base_price: number;
  weekend_base_price: number | null;
  cleaning_fee: number;
  extra_person_fee: number;
  guests_included: number;
  weekly_price_factor: number;
  monthly_price_factor: number;
  taxes: string; // JSON string
  min_nights: number;
  max_nights: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  active: number; // SQLite boolean (0 or 1)
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Raw availability row from database
 */
export interface AvailabilityRow {
  id: number;
  listing_id: string;
  date: string;
  status: AvailabilityStatus;
  price: number;
  min_nights: number;
  closed_to_arrival: number; // SQLite boolean (0 or 1)
  closed_to_departure: number; // SQLite boolean (0 or 1)
  block_type: BlockType;
  block_ref: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Raw quote cache row from database (before JSON parsing)
 */
export interface QuoteCacheRow {
  id: number;
  listing_id: string;
  check_in: string;
  check_out: string;
  guests: number;
  nights: number;
  currency: string;
  accommodation_fare: number;
  cleaning_fee: number;
  extra_guest_fee: number;
  subtotal: number;
  total_taxes: number;
  total_price: number;
  discount_applied: 'weekly' | 'monthly' | null;
  discount_factor: number | null;
  discount_savings: number | null;
  breakdown: string; // JSON string
  expires_at: string;
  created_at: string;
}

// ============================================================================
// HELPER TYPE GUARDS
// ============================================================================

/**
 * Type guard to check if a status is valid
 */
export function isValidStatus(status: string): status is AvailabilityStatus {
  return ['available', 'blocked', 'booked'].includes(status);
}

/**
 * Type guard to check if a block type is valid
 */
export function isValidBlockType(type: string | null): type is BlockType {
  return type === null || ['reservation', 'owner', 'manual', 'maintenance'].includes(type);
}

// ============================================================================
// TRANSFORM UTILITIES
// ============================================================================

/**
 * Convert raw ListingRow from SQLite to Listing model
 */
export function rowToListing(row: ListingRow): Listing {
  return {
    ...row,
    active: row.active === 1,
    taxes: JSON.parse(row.taxes) as Tax[],
  };
}

/**
 * Convert raw AvailabilityRow from SQLite to Availability model
 */
export function rowToAvailability(row: AvailabilityRow): Availability {
  return {
    ...row,
    closed_to_arrival: row.closed_to_arrival === 1,
    closed_to_departure: row.closed_to_departure === 1,
  };
}

/**
 * Convert raw QuoteCacheRow from SQLite to QuoteCache model
 */
export function rowToQuoteCache(row: QuoteCacheRow): QuoteCache {
  return {
    ...row,
    breakdown: JSON.parse(row.breakdown) as PriceBreakdown,
  };
}