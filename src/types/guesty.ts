/**
 * Guesty API Response Type Definitions
 *
 * These types represent the structure of responses from the Guesty Open API.
 * See docs/GUESTY_API_ANALYSIS.md for detailed documentation.
 */

// ============================================================================
// GUESTY API MODELS
// ============================================================================

/**
 * Guesty listing/property response
 */
export interface GuestyListing {
  _id: string;
  title: string;
  nickname?: string;
  accommodates: number;
  bedrooms?: number;
  bathrooms?: number;
  propertyType?: string;
  roomType?: string;
  timezone: string;
  active?: boolean;
  listed?: boolean;

  prices: {
    basePrice: number;
    currency: string;
    cleaningFee?: number;
    extraPersonFee?: number;
    guestsIncludedInRegularFee?: number;
    weeklyPriceFactor?: number;
    monthlyPriceFactor?: number;
    weekendBasePrice?: number;
  };

  taxes?: GuestyTax[];
  accountTaxes?: GuestyTax[];

  terms?: {
    minNights?: number;
    maxNights?: number;
    checkInTime?: string;
    checkOutTime?: string;
  };

  address?: {
    full?: string;
    city?: string;
    country?: string;
    lat?: number;
    lng?: number;
  };

  publicDescription?: {
    summary?: string;
    space?: string;
  };

  amenities?: string[];
  pictures?: Array<{
    _id: string;
    thumbnail?: string;
    regular?: string;
  }>;
}

/**
 * Guesty tax configuration
 */
export interface GuestyTax {
  _id: string;
  type: string; // 'LOCAL_TAX', 'CITY_TAX', 'VAT', etc.
  amount: number;
  units: 'PERCENTAGE' | 'FIXED';
  quantifier: 'PER_NIGHT' | 'PER_STAY' | 'PER_GUEST' | 'PER_GUEST_PER_NIGHT';
  appliedToAllFees: boolean;
  appliedOnFees?: string[];
  isAppliedByDefault?: boolean;
  appliedByDefaultOnChannels?: string[];
}

/**
 * Guesty calendar day response
 */
export interface GuestyCalendarDay {
  date: string; // ISO 8601 date (YYYY-MM-DD)
  listingId: string;
  currency: string;
  price: number;
  isBasePrice?: boolean;
  minNights: number;
  isBaseMinNights?: boolean;
  status: 'available' | 'unavailable';

  // Multi-unit properties
  allotment?: number;

  // Restrictions
  cta?: boolean; // Closed to arrival
  ctd?: boolean; // Closed to departure

  // Block information (boolean flags)
  blocks?: {
    m?: boolean;      // manual
    r?: boolean;      // (unknown)
    b?: boolean;      // booking/reservation
    bd?: boolean;     // (unknown)
    sr?: boolean;     // (unknown)
    abl?: boolean;    // (unknown)
    a?: boolean;      // (unknown)
    bw?: boolean;     // (unknown)
    o?: boolean;      // owner
    pt?: boolean;     // (unknown)
    an?: boolean;     // (unknown)
  };
  blockRefs?: Array<{
    _id: string;
    listingId: string;
    startDate: string;
    endDate: string;
    type: string;
    reservationId?: string;
    reservation?: {
      _id: string;
      listingId: string;
      accountId?: string;
      checkIn: string;
      checkOut: string;
      checkInDateLocalized?: string;
      checkOutDateLocalized?: string;
      status: string;
      confirmationCode?: string;
      source?: string;
      guestId?: string;
      guest?: {
        _id: string;
        fullName?: string;
      };
      money?: {
        balanceDue?: number;
        currency?: string;
        hostPayout?: number;
        totalPaid?: number;
        fareAccommodationAdjusted?: number;
      };
      nightsCount?: number;
      plannedArrival?: string;
      plannedDeparture?: string;
      guestsCount?: number;
      integration?: {
        platform?: string;
      };
      numberOfGuests?: {
        numberOfAdults?: number;
        numberOfChildren?: number;
        numberOfInfants?: number;
      };
      createdAt?: string;
      reservedAt?: string;
    };
  }>;
}

/**
 * Guesty calendar response (array of days)
 */
export type GuestyCalendarResponse = GuestyCalendarDay[];

/**
 * Guesty quote/pricing response
 */
export interface GuestyQuote {
  listingId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  currency: string;
  basePrice: number;
  price: number; // Adjusted price after rate plans

  ratePlan?: {
    priceAdjustment?: {
      type: 'percent' | 'flat';
      direction: 'increase' | 'decrease';
      amount: number;
    };
  };

  fees?: {
    cleaningFee?: number;
    extraGuestFee?: number;
    petFee?: number;
    [key: string]: number | undefined;
  };

  taxes?: Record<string, number>;

  totalPrice: number;

  nightlyBreakdown?: Array<{
    date: string;
    basePrice: number;
    adjustedPrice: number;
  }>;
}

/**
 * Guesty guest address
 */
export interface GuestyGuestAddress {
  full?: string;
  street?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
  countryCode?: string;
}

/**
 * Guesty guest response from /guests-crud/{guestId}
 */
export interface GuestyGuest {
  _id: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  address?: GuestyGuestAddress;
  company?: string;
  hometown?: string;
  notes?: string;
  tags?: string[];
  nationality?: string;
  preferredLanguage?: string;
}

/**
 * Guesty API error response
 */
export interface GuestyError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// API RESPONSE WRAPPERS
// ============================================================================

/**
 * Generic API response wrapper
 */
export interface GuestyApiResponse<T> {
  data?: T;
  error?: GuestyError;
  status: number;
}

/**
 * Paginated response (if needed in future)
 */
export interface GuestyPaginatedResponse<T> {
  results: T[];
  count: number;
  limit: number;
  skip: number;
}