# API Endpoints Documentation

This document describes all public API endpoints available for the frontend to consume.

## Base URL

```
http://localhost:3000
```

## Overview

The API provides read-only endpoints for:
- Listing information (property details, pricing configuration)
- Availability calendar (daily status and pricing)
- Price quotes (computed pricing with full breakdown)

All endpoints return JSON and require no authentication.

---

## Public Endpoints

### 1. Get Listing Information

Retrieve property details, pricing configuration, and terms.

**Endpoint:** `GET /listing`

**Parameters:** None

**Response:**

```json
{
  "id": "farmhouse-prasser-001",
  "title": "Farmhouse Prasser - Peaceful Countryside Retreat",
  "accommodates": 8,
  "bedrooms": 4,
  "bathrooms": 2,
  "propertyType": "House",
  "timezone": "Europe/Berlin",
  "currency": "EUR",
  "pricing": {
    "basePrice": 200,
    "weekendBasePrice": 250,
    "cleaningFee": 75,
    "extraPersonFee": 25,
    "guestsIncluded": 4,
    "weeklyDiscount": 10,
    "monthlyDiscount": 15
  },
  "taxes": [
    {
      "id": "tax-local-bavaria",
      "type": "LOCAL_TAX",
      "amount": 10,
      "units": "PERCENTAGE",
      "quantifier": "PER_NIGHT",
      "appliedToAllFees": false,
      "appliedOnFees": ["AF"]
    },
    {
      "id": "tax-city-tourist",
      "type": "CITY_TAX",
      "amount": 2.50,
      "units": "FIXED",
      "quantifier": "PER_GUEST_PER_NIGHT",
      "appliedToAllFees": false,
      "appliedOnFees": []
    }
  ],
  "terms": {
    "minNights": 2,
    "maxNights": 28,
    "checkInTime": "16:00",
    "checkOutTime": "11:00"
  }
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique listing identifier |
| `title` | String | Property title |
| `accommodates` | Integer | Maximum number of guests |
| `bedrooms` | Integer\|null | Number of bedrooms |
| `bathrooms` | Number\|null | Number of bathrooms (can be decimal) |
| `propertyType` | String\|null | Property type (e.g., "House", "Apartment") |
| `timezone` | String | IANA timezone (e.g., "Europe/Berlin") |
| `currency` | String | ISO 4217 currency code (e.g., "EUR", "USD") |
| `pricing.basePrice` | Number | Base nightly rate (weekdays) |
| `pricing.weekendBasePrice` | Number\|null | Weekend nightly rate (Fri/Sat) |
| `pricing.cleaningFee` | Number | One-time cleaning fee per stay |
| `pricing.extraPersonFee` | Number | Fee per guest beyond included count |
| `pricing.guestsIncluded` | Integer | Number of guests included in base price |
| `pricing.weeklyDiscount` | Number | Percentage discount for 7+ night stays |
| `pricing.monthlyDiscount` | Number | Percentage discount for 28+ night stays |
| `taxes[]` | Array | Tax configuration objects |
| `terms.minNights` | Integer | Minimum stay requirement (nights) |
| `terms.maxNights` | Integer\|null | Maximum stay limit (nights) |
| `terms.checkInTime` | String\|null | Check-in time (e.g., "16:00") |
| `terms.checkOutTime` | String\|null | Check-out time (e.g., "11:00") |

**Error Responses:**

- `404 Not Found` - Listing not found (run data sync first)

---

### 2. Get Availability Calendar

Retrieve daily availability, status, and pricing for a date range.

**Endpoint:** `GET /availability`

**Query Parameters:**

| Parameter | Type | Required | Format | Description |
|-----------|------|----------|--------|-------------|
| `from` | String | Yes | `YYYY-MM-DD` | Start date (inclusive) |
| `to` | String | Yes | `YYYY-MM-DD` | End date (inclusive) |

**Example Request:**

```
GET /availability?from=2025-04-15&to=2025-04-22
```

**Response:**

```json
{
  "from": "2025-04-15",
  "to": "2025-04-22",
  "currency": "EUR",
  "days": [
    {
      "date": "2025-04-15",
      "status": "available",
      "price": 200,
      "minNights": 2,
      "closedToArrival": false,
      "closedToDeparture": false
    },
    {
      "date": "2025-04-16",
      "status": "available",
      "price": 200,
      "minNights": 2,
      "closedToArrival": false,
      "closedToDeparture": false
    },
    {
      "date": "2025-04-17",
      "status": "booked",
      "price": 0,
      "minNights": 1,
      "closedToArrival": true,
      "closedToDeparture": true
    }
  ]
}
```

**Day Fields:**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `date` | String | `YYYY-MM-DD` | Date in property's timezone |
| `status` | String | `available`, `blocked`, `booked` | Availability status |
| `price` | Number | - | Nightly rate for this date (0 if unavailable) |
| `minNights` | Integer | - | Minimum stay requirement for this date |
| `closedToArrival` | Boolean | - | Cannot check in on this date |
| `closedToDeparture` | Boolean | - | Cannot check out on this date |

**Status Values:**
- `available` - Can be booked
- `blocked` - Blocked by owner or maintenance
- `booked` - Already reserved

**Validation:**
- Date format must be `YYYY-MM-DD`
- `from` must be before or equal to `to`
- Date range cannot exceed 365 days

**Error Responses:**

- `400 Bad Request` - Invalid parameters
  ```json
  {
    "error": {
      "name": "ValidationError",
      "message": "Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15)",
      "code": "VALIDATION_ERROR",
      "statusCode": 400
    }
  }
  ```

---

### 3. Get Price Quote

Calculate complete pricing with breakdown for a specific booking request.

**Endpoint:** `GET /quote`

**Query Parameters:**

| Parameter | Type | Required | Format | Description |
|-----------|------|----------|--------|-------------|
| `checkIn` | String | Yes | `YYYY-MM-DD` | Check-in date |
| `checkOut` | String | Yes | `YYYY-MM-DD` | Check-out date |
| `guests` | Integer | Yes | `1-N` | Number of guests |

**Example Request:**

```
GET /quote?checkIn=2025-04-15&checkOut=2025-04-22&guests=6
```

**Response:**

```json
{
  "cached": false,
  "quote": {
    "checkIn": "2025-04-15",
    "checkOut": "2025-04-22",
    "guests": 6,
    "nights": 7,
    "currency": "EUR",
    "pricing": {
      "accommodationFare": 1350,
      "cleaningFee": 75,
      "extraGuestFee": 50,
      "subtotal": 1475,
      "totalTaxes": 240,
      "totalPrice": 1715
    },
    "discount": {
      "type": "weekly",
      "factor": 0.90,
      "savings": 150
    },
    "breakdown": {
      "nightlyRates": [
        {
          "date": "2025-04-15",
          "basePrice": 200,
          "adjustedPrice": 180,
          "note": "Weekly discount"
        },
        {
          "date": "2025-04-16",
          "basePrice": 200,
          "adjustedPrice": 180,
          "note": "Weekly discount"
        }
      ],
      "accommodationFare": 1350,
      "fees": {
        "cleaning": 75,
        "extraGuest": 50
      },
      "taxes": [
        {
          "type": "LOCAL_TAX",
          "amount": 135,
          "description": "10% on AF",
          "calculation": "1350.00 × 10% = 135.00"
        },
        {
          "type": "CITY_TAX",
          "amount": 105,
          "description": "2.5 per per guest per night",
          "calculation": "2.5 × 6 guests × 7 nights = 105.00"
        }
      ],
      "subtotal": 1475,
      "totalTaxes": 240,
      "total": 1715
    }
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `cached` | Boolean | Whether quote was served from cache |
| `quote.checkIn` | String | Check-in date |
| `quote.checkOut` | String | Check-out date |
| `quote.guests` | Integer | Number of guests |
| `quote.nights` | Integer | Number of nights |
| `quote.currency` | String | Currency code |
| `quote.pricing.accommodationFare` | Number | Total nightly rates (after discount) |
| `quote.pricing.cleaningFee` | Number | One-time cleaning fee |
| `quote.pricing.extraGuestFee` | Number | Fee for extra guests |
| `quote.pricing.subtotal` | Number | Total before taxes |
| `quote.pricing.totalTaxes` | Number | Sum of all taxes |
| `quote.pricing.totalPrice` | Number | **Final total price** |
| `quote.discount` | Object\|null | Discount information (if applicable) |
| `quote.discount.type` | String | `"weekly"` or `"monthly"` |
| `quote.discount.factor` | Number | Discount multiplier (e.g., 0.90 = 10% off) |
| `quote.discount.savings` | Number | Amount saved |
| `quote.breakdown` | Object | Detailed breakdown |

**Breakdown Object:**

- `nightlyRates[]` - Per-night pricing details
  - `date` - Date string
  - `basePrice` - Original price
  - `adjustedPrice` - Price after discount
  - `note` - Optional description (e.g., "Weekend rate", "Weekly discount")

- `fees` - Fee breakdown
  - `cleaning` - Cleaning fee
  - `extraGuest` - Extra guest fee

- `taxes[]` - Tax breakdown
  - `type` - Tax type (e.g., "LOCAL_TAX", "CITY_TAX")
  - `amount` - Tax amount
  - `description` - Human-readable description
  - `calculation` - Formula used (optional)

**Validation:**

The quote endpoint validates:
- Date format (YYYY-MM-DD)
- Check-out after check-in
- Guest count (1 to property max)
- Minimum stay requirement
- Maximum stay limit
- Date availability

**Error Responses:**

- `400 Bad Request` - Invalid parameters or validation failed
  ```json
  {
    "error": {
      "name": "ValidationError",
      "message": "Minimum stay is 2 nights",
      "code": "VALIDATION_ERROR",
      "statusCode": 400
    }
  }
  ```

- `400 Bad Request` - Dates not available
  ```json
  {
    "error": {
      "name": "ValidationError",
      "message": "Selected dates are not available",
      "code": "VALIDATION_ERROR",
      "statusCode": 400
    }
  }
  ```

- `400 Bad Request` - Too many guests
  ```json
  {
    "error": {
      "name": "ValidationError",
      "message": "Property accommodates maximum 8 guests",
      "code": "VALIDATION_ERROR",
      "statusCode": 400
    }
  }
  ```

**Caching:**

Quotes are cached for 1 hour (configurable via `CACHE_QUOTE_TTL`). The `cached` field indicates whether the response was served from cache.

---

## Admin Endpoints

These endpoints are for managing data synchronization.

### Sync Data

**POST /sync/all** - Sync listing and availability data
**POST /sync/listing** - Sync listing only
**POST /sync/availability** - Sync availability only

Add `?force=true` to ignore cache freshness.

### Get Sync Status

**GET /sync/status** - Get scheduler status and job info

---

## Error Handling

All errors follow this format:

```json
{
  "error": {
    "name": "ErrorName",
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "statusCode": 400,
    "details": {}
  }
}
```

**Common Error Codes:**
- `VALIDATION_ERROR` (400) - Invalid request parameters
- `NOT_FOUND` (404) - Resource not found
- `DATABASE_ERROR` (500) - Database operation failed
- `EXTERNAL_API_ERROR` (502) - Guesty API error

---

## CORS

All endpoints support CORS with `Access-Control-Allow-Origin: *` for easy frontend integration.

---

## Response Times

**Typical response times:**
- `/listing` - <10ms (database read)
- `/availability` - <50ms (depends on date range)
- `/quote` - <10ms (cached), <100ms (calculated)

---

## Examples

### Complete Booking Flow

1. **Get property info:**
   ```bash
   curl http://localhost:3000/listing
   ```

2. **Check availability for dates:**
   ```bash
   curl "http://localhost:3000/availability?from=2025-04-15&to=2025-04-30"
   ```

3. **Get price quote:**
   ```bash
   curl "http://localhost:3000/quote?checkIn=2025-04-15&checkOut=2025-04-22&guests=6"
   ```

4. **Display total price to user:** `€1,715`

5. **Generate mailto link with booking details** (frontend implementation)

---

## Frontend Integration

### JavaScript/Fetch Example

```javascript
// Get listing info
const listing = await fetch('http://localhost:3000/listing')
  .then(res => res.json());

// Get availability for next 30 days
const today = new Date().toISOString().split('T')[0];
const nextMonth = new Date();
nextMonth.setDate(nextMonth.getDate() + 30);
const nextMonthStr = nextMonth.toISOString().split('T')[0];

const availability = await fetch(
  `http://localhost:3000/availability?from=${today}&to=${nextMonthStr}`
).then(res => res.json());

// Get price quote
const quote = await fetch(
  `http://localhost:3000/quote?checkIn=2025-04-15&checkOut=2025-04-22&guests=6`
).then(res => res.json());

console.log('Total price:', quote.quote.pricing.totalPrice, quote.quote.currency);
```

### Error Handling

```javascript
async function getQuote(checkIn, checkOut, guests) {
  try {
    const response = await fetch(
      `http://localhost:3000/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error.message);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to get quote:', error.message);
    // Show error to user
  }
}
```

---

## Rate Limiting

Currently, there is no rate limiting. For production, consider:
- Adding rate limiting middleware
- Implementing API key authentication for admin endpoints
- Setting up request throttling

---

## Next Steps

Future endpoint additions:
- `POST /booking` - Direct booking (requires payment integration)
- `GET /bookings/:id` - Get booking status
- `POST /contact` - Send inquiry email