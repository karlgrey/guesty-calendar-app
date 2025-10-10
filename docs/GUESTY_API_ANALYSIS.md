# Guesty API Analysis

This document provides a comprehensive analysis of the Guesty Open API endpoints and data structures needed to build a booking calendar application.

## Table of Contents
- [Authentication](#authentication)
- [Key Endpoints](#key-endpoints)
- [Calendar Availability Endpoint](#calendar-availability-endpoint)
- [Listing Details Endpoint](#listing-details-endpoint)
- [Quotes/Pricing Endpoint](#quotespricing-endpoint)
- [Pricing Calculations](#pricing-calculations)
- [API Quirks and Best Practices](#api-quirks-and-best-practices)

---

## Authentication

All Guesty Open API endpoints require header-based authentication:
- Base URL: `https://open-api.guesty.com/v1/`
- Authentication: API credentials via headers
- Documentation: https://open-api-docs.guesty.com/

---

## Key Endpoints

### 1. Calendar Availability
**Endpoint:** `GET /availability-pricing/api/calendar/listings/{id}`

**Purpose:** Retrieve daily calendar availability and pricing for a specific listing

**Query Parameters:**
- Date range parameters (start/end dates)

**Use Case:** Display available/blocked dates and daily pricing in the calendar UI

### 2. Listing Details
**Endpoint:** `GET /listings/{id}`

**Purpose:** Retrieve complete property details including capacity, pricing, fees, and taxes

**Use Case:** Get base pricing configuration, guest capacity, and fee structure

### 3. Price Quote
**Endpoint:** `POST /quotes`

**Purpose:** Generate a detailed price quote for a potential reservation

**Use Case:** Calculate complete pricing with all fees, taxes, and discounts for a specific date range and guest count

---

## Calendar Availability Endpoint

### Response Structure

```json
{
  "date": "2024-03-29",
  "listingId": "abc123",
  "currency": "USD",
  "price": 300,
  "isBasePrice": true,
  "minNights": 2,
  "isBaseMinNights": true,
  "status": "available",
  "blocks": {},
  "blockRefs": [],
  "cta": false,
  "ctd": false,
  "allotment": 1
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `date` | String | Date in `YYYY-MM-DD` format |
| `price` | Number | Nightly rate for this date in the specified currency |
| `minNights` | Integer | Minimum stay requirement for this date |
| `status` | String | `"available"` or `"unavailable"` |
| `currency` | String | Three-letter currency code (e.g., `"USD"`, `"EUR"`) |
| `isBasePrice` | Boolean | Indicates if this is the base price (not adjusted) |
| `isBaseMinNights` | Boolean | Indicates if this is the base minimum nights value |
| `cta` | Boolean | Closed to arrival (cannot check in on this date) |
| `ctd` | Boolean | Closed to departure (cannot check out on this date) |
| `allotment` | Number | For multi-unit properties: number of units available |

### Availability Calculation

For **multi-unit properties**, availability is determined by:
```javascript
const isAvailable = _.isNumber(currentDay.allotment)
  ? currentDay.allotment > 0
  : currentDay.status === 'available'
```

For **single-unit properties**, use the `status` field directly.

---

## Listing Details Endpoint

### Response Structure (Key Fields)

```json
{
  "_id": "abc123",
  "title": "Beautiful Farmhouse",
  "accommodates": 8,
  "timezone": "Europe/Berlin",
  "prices": {
    "basePrice": 200,
    "currency": "EUR",
    "cleaningFee": 75,
    "extraPersonFee": 25,
    "guestsIncludedInRegularFee": 4,
    "weeklyPriceFactor": 0.90,
    "monthlyPriceFactor": 0.85,
    "weekendBasePrice": 250
  },
  "taxes": [
    {
      "_id": "tax123",
      "type": "LOCAL_TAX",
      "amount": 10,
      "units": "PERCENTAGE",
      "quantifier": "PER_NIGHT",
      "appliedToAllFees": false,
      "appliedOnFees": ["AF", "CF"],
      "isAppliedByDefault": true
    }
  ]
}
```

### Guest Capacity

| Field | Type | Description |
|-------|------|-------------|
| `accommodates` | Integer | Maximum number of guests the property can accommodate |

**Note:** The Guesty API uses `accommodates` as the standard field for guest capacity. There is no separate `maxGuests` field.

### Pricing Fields

| Field | Type | Description |
|-------|------|-------------|
| `basePrice` | Number | Base nightly rate (flat rate across all dates unless calendar-adjusted) |
| `currency` | String | Three-letter currency code |
| `cleaningFee` | Number | One-time cleaning fee per stay |
| `extraPersonFee` | Number | Fee per extra guest beyond included count |
| `guestsIncludedInRegularFee` | Integer | Number of guests included in base price |
| `weekendBasePrice` | Number | Optional higher rate for Friday/Saturday nights |
| `weeklyPriceFactor` | Number | Discount factor for 7+ night stays (e.g., 0.90 = 10% off) |
| `monthlyPriceFactor` | Number | Discount factor for 28+ night stays (e.g., 0.85 = 15% off) |

### Discount Factors

Discounts are expressed as **fractions of the full price**:
- `1.0` = no discount
- `0.95` = 5% discount
- `0.90` = 10% discount
- `0.85` = 15% discount

**Example:** If `weeklyPriceFactor = 0.90`, a 7-night stay gets 10% off the nightly rate.

### Tax Structure

Each tax object in the `taxes` array contains:

| Field | Type | Description |
|-------|------|-------------|
| `_id` | String | Unique tax identifier |
| `type` | String | Tax type: `"LOCAL_TAX"`, `"CITY_TAX"`, `"VAT"`, etc. |
| `amount` | Number | Tax amount (percentage or fixed value) |
| `units` | String | `"PERCENTAGE"` or `"FIXED"` |
| `quantifier` | String | `"PER_NIGHT"`, `"PER_STAY"`, `"PER_GUEST"`, `"PER_GUEST_PER_NIGHT"` |
| `appliedToAllFees` | Boolean | If true, tax applies to all fees |
| `appliedOnFees` | Array | Fee codes the tax applies to (e.g., `["AF", "CF", "CLEANING"]`) |

**Fee Codes:**
- `AF` = Accommodation Fare (nightly rate)
- `CF` = Cleaning Fee
- `CLEANING` = Cleaning Fee
- Many others for specific amenities (parking, pet fees, etc.)

---

## Quotes/Pricing Endpoint

### Request

```http
POST /v1/quotes
Content-Type: application/json

{
  "listingId": "abc123",
  "checkIn": "2024-04-01",
  "checkOut": "2024-04-07",
  "guests": 6
}
```

### Response Structure

```json
{
  "basePrice": 200,
  "price": 192,
  "currency": "EUR",
  "ratePlan": {
    "priceAdjustment": {
      "type": "percent",
      "direction": "decrease",
      "amount": 4
    }
  },
  "fees": {
    "cleaningFee": 75,
    "extraGuestFee": 50,
    "petFee": 0
  },
  "taxes": {
    "localTax": 96.5,
    "cityTax": 30
  },
  "totalPrice": 1529.50,
  "nightlyBreakdown": [
    {
      "date": "2024-04-01",
      "basePrice": 200,
      "adjustedPrice": 192
    }
  ]
}
```

### Key Pricing Fields

| Field | Description |
|-------|-------------|
| `basePrice` | Nightly base rate before adjustments |
| `price` | Final calculated nightly rate after rate plan adjustments |
| `ratePlan.priceAdjustment` | Details of any promotional or rate plan discounts |
| `fees` | Breakdown of all additional fees (cleaning, extra guest, pet, etc.) |
| `taxes` | Calculated taxes based on the reservation details |
| `totalPrice` | Complete total including all nights, fees, and taxes |

---

## Pricing Calculations

### Step-by-Step Calculation

To compute the total price for a booking:

#### 1. Calculate Accommodation Fare (Nightly Total)

```javascript
// For each night
const nightlyRate = calendarDay.price; // From calendar API
const numNights = checkOut - checkIn; // in days
const accommodationFare = nightlyRate * numNights;
```

#### 2. Apply Length-of-Stay Discounts

```javascript
let discount = 1.0;

if (numNights >= 28) {
  discount = listing.prices.monthlyPriceFactor; // e.g., 0.85
} else if (numNights >= 7) {
  discount = listing.prices.weeklyPriceFactor; // e.g., 0.90
}

const discountedAccommodationFare = accommodationFare * discount;
```

#### 3. Calculate Extra Guest Fees

```javascript
const includedGuests = listing.prices.guestsIncludedInRegularFee;
const extraGuests = Math.max(0, numGuests - includedGuests);
const extraGuestFee = extraGuests * listing.prices.extraPersonFee;
```

#### 4. Add Cleaning Fee (Once Per Stay)

```javascript
const cleaningFee = listing.prices.cleaningFee;
```

#### 5. Calculate Subtotal Before Taxes

```javascript
const subtotal = discountedAccommodationFare + extraGuestFee + cleaningFee;
```

#### 6. Apply Taxes

For each tax in `listing.taxes`:

```javascript
listing.taxes.forEach(tax => {
  let taxableAmount = 0;

  if (tax.appliedToAllFees) {
    taxableAmount = subtotal;
  } else {
    // Calculate based on appliedOnFees array
    if (tax.appliedOnFees.includes('AF')) {
      taxableAmount += discountedAccommodationFare;
    }
    if (tax.appliedOnFees.includes('CF') || tax.appliedOnFees.includes('CLEANING')) {
      taxableAmount += cleaningFee;
    }
    // Add other fees if applicable
  }

  let taxAmount = 0;

  if (tax.units === 'PERCENTAGE') {
    taxAmount = taxableAmount * (tax.amount / 100);
  } else if (tax.units === 'FIXED') {
    // Calculate based on quantifier
    if (tax.quantifier === 'PER_NIGHT') {
      taxAmount = tax.amount * numNights;
    } else if (tax.quantifier === 'PER_STAY') {
      taxAmount = tax.amount;
    } else if (tax.quantifier === 'PER_GUEST') {
      taxAmount = tax.amount * numGuests;
    } else if (tax.quantifier === 'PER_GUEST_PER_NIGHT') {
      taxAmount = tax.amount * numGuests * numNights;
    }
  }

  totalTaxes += taxAmount;
});
```

#### 7. Calculate Grand Total

```javascript
const totalPrice = subtotal + totalTaxes;
```

### Required Fields for Complete Calculation

To compute pricing locally, you need:

**From Calendar API (per day):**
- `date`
- `price` (nightly rate)
- `minNights`
- `status`

**From Listing API:**
- `accommodates` (max guests)
- `prices.basePrice`
- `prices.currency`
- `prices.cleaningFee`
- `prices.extraPersonFee`
- `prices.guestsIncludedInRegularFee`
- `prices.weeklyPriceFactor`
- `prices.monthlyPriceFactor`
- `taxes[]` (complete tax array)
- `timezone`

---

## Rate Limiting

### Guesty API Rate Limits

Guesty enforces the following rate limits on their Open API (as of 2025):

| Interval | Limit |
|----------|-------|
| Per Second | 15 requests |
| Per Minute | 120 requests |
| Per Hour | 5,000 requests |
| Concurrent Requests | Maximum 15 |

**Important Notes:**
- Rate limits are **shared across all API tokens** for your account
- Exceeding 15 concurrent requests triggers instant rate limiting
- Official partner integrations through Guesty Marketplace are not affected by these limits

### Rate Limit Response Headers

Guesty includes rate limit information in response headers:

```
X-ratelimit-limit-second: 15
X-ratelimit-remaining-second: 12
X-ratelimit-limit-minute: 120
X-ratelimit-remaining-minute: 95
X-ratelimit-limit-hour: 5000
X-ratelimit-remaining-hour: 4832
```

### Handling 429 Responses

When receiving `HTTP 429 Too Many Requests`:
1. Check the `Retry-After` header (value in seconds)
2. Wait for the specified duration before retrying
3. Implement exponential backoff if `Retry-After` is not provided
4. Add jitter (randomization) to prevent thundering herd

### Best Practices for Rate Limiting

1. **Request Queuing**: Implement a request queue with throttling (10-12 req/sec, leaving buffer)
2. **Concurrent Request Control**: Limit concurrent requests to 10-12 (below the 15 limit)
3. **Retry Logic**: Implement exponential backoff with jitter for 429 responses
4. **Monitor Headers**: Track `X-ratelimit-remaining-*` headers and slow down when approaching limits
5. **Batch Operations**: Add delays between sequential API calls (1-2 seconds recommended)
6. **Webhooks**: Use webhooks for notifications instead of polling
7. **Optimize Requests**: Only fetch required fields to minimize request count

### This Application's Rate Limit Strategy

This application implements comprehensive rate limiting protection:

- **Request Queue**: Uses Bottleneck library to enforce 10 req/sec limit with 10 concurrent requests max
- **Automatic Retry**: Retries 429 responses up to 3 times with exponential backoff and ±20% jitter
- **Header Monitoring**: Tracks rate limit headers and logs warnings when approaching limits (< 20% remaining)
- **Chunked Sync**: When syncing 12 months of availability, chunks are fetched with 1-second delays between requests
- **Scheduler Interval**: ETL job runs every 60 minutes (configurable via `CACHE_AVAILABILITY_TTL`)
- **Startup Jitter**: Scheduler adds ±5% random jitter to prevent multiple instances syncing simultaneously

---

## API Quirks and Best Practices

### 1. Date Formats

**Calendar API:**
- Returns dates in simple `YYYY-MM-DD` format
- Example: `"2024-03-29"`

**Reservation/Booking APIs:**
- Use `checkInDateLocalized` and `checkOutDateLocalized` fields
- Format: `YYYY-MM-DD` (without time component)
- **AVOID** `checkIn`/`checkOut` fields with UTC timestamps (e.g., `2023-01-30T10:00:00+02:00`)
- Using UTC-formatted dates can cause **timezone and date discrepancies**

**Best Practice:** Always use localized date fields (`checkInDateLocalized`, `checkOutDateLocalized`) with simple `YYYY-MM-DD` format to prevent timezone conversion issues.

### 2. Time Zones

- Listings include a `timezone` field (e.g., `"Europe/Berlin"`, `"America/Los_Angeles"`)
- Calendar dates are localized to the listing's timezone
- All date calculations should respect the listing's timezone to avoid off-by-one errors

### 3. Currency

- All monetary values are in the listing's specified `currency`
- Currency is a three-letter code (ISO 4217): `"USD"`, `"EUR"`, `"GBP"`, etc.
- Ensure all calculations use the same currency
- Display formatting should match the locale (e.g., `€200.00` for EUR, `$200.00` for USD)

### 4. Multi-Unit Properties

- For properties with multiple units, check the `allotment` field
- If `allotment` is a number, use it to determine availability (`allotment > 0`)
- If `allotment` is not present, fall back to the `status` field

### 5. Minimum Stay Requirements

- The `minNights` value can vary by date (e.g., higher during peak season)
- Always validate that the selected date range meets the minimum stay for the check-in date
- Some listings may have `isBaseMinNights: false`, indicating a custom override

### 6. Weekend Pricing

- If `prices.weekendBasePrice` is present, it overrides `basePrice` for Friday/Saturday nights
- Weekend logic should be calculated in the listing's local timezone

### 7. Tax Complexity

- Taxes can be percentage-based or fixed amounts
- Taxes can apply to all fees or specific fee types
- Tax quantifiers vary: per night, per stay, per guest, or per guest per night
- **Important:** Not all taxes apply to all fees—check `appliedOnFees` array

### 8. Rate Plans and Dynamic Pricing

- The calendar API returns adjusted prices per day
- These prices may already include rate plan adjustments
- The quotes API provides detailed breakdown including rate plan details
- For MVP, using calendar prices is simpler than recalculating base price adjustments

### 9. Error Handling

- API may return errors if:
  - Listing ID is invalid
  - Date range is outside the available calendar window (typically max 12-18 months ahead)
  - Authentication credentials are invalid or expired

### 10. Caching Recommendations

- **Listing data:** Cache for 24 hours (changes infrequently)
- **Calendar data:** Cache for 60-120 minutes (pricing and availability change often, but must balance with rate limits)
- **Quotes:** Cache for 60 minutes (reduces API calls while maintaining reasonable freshness)

**Important:** Caching strategy must balance data freshness with rate limit constraints. The `CACHE_AVAILABILITY_TTL` setting controls both cache duration and ETL scheduler interval. Recommended minimum: 60 minutes to stay well below rate limits.

### 11. Performance Considerations

- Calendar API returns data for a date range—fetch 30-90 days at a time
- For 12-month calendar view, consider fetching data in chunks as user navigates
- Listing data is relatively small—can be embedded in the calendar response cache

---

## Next Steps

1. **Create sample JSON fixtures** for common scenarios:
   - Available date
   - Blocked date
   - Discounted weekly stay (7+ nights)
   - Over-capacity guest count validation
   - Weekend pricing example
   - Peak season with higher min-stay

2. **Test edge cases:**
   - Leap year dates
   - Cross-year bookings (Dec-Jan)
   - Same-day check-in/check-out (should be rejected)
   - Guests exceeding `accommodates`

3. **Build normalization layer** to transform Guesty API responses into simplified internal data model

4. **Set up SQLite schema** to cache listing and calendar data efficiently