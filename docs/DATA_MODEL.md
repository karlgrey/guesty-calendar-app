# Internal Data Model & Schema

This document defines the internal SQLite database schema for caching Guesty API data and serving fast, consistent responses.

## Design Principles

1. **Minimal Schema** - Store only what's needed for the booking UI
2. **Fast Queries** - Optimize for read performance with proper indexes
3. **Cache-Friendly** - Include timestamps for cache invalidation
4. **Timezone Safety** - Store dates in property timezone, convert only when needed
5. **Denormalization** - Duplicate some data for query speed (pricing config in listings table)

---

## Database Tables

### 1. listings

Stores property details, pricing configuration, and metadata.

```sql
CREATE TABLE listings (
  id TEXT PRIMARY KEY,                    -- Guesty listing ID
  title TEXT NOT NULL,
  accommodates INTEGER NOT NULL,          -- Max guests
  bedrooms INTEGER,
  bathrooms REAL,
  property_type TEXT,
  timezone TEXT NOT NULL,                 -- IANA timezone (e.g., 'Europe/Berlin')

  -- Pricing
  currency TEXT NOT NULL,                 -- ISO 4217 code (EUR, USD, etc.)
  base_price REAL NOT NULL,               -- Base nightly rate
  weekend_base_price REAL,                -- Weekend rate (optional)
  cleaning_fee REAL NOT NULL DEFAULT 0,
  extra_person_fee REAL NOT NULL DEFAULT 0,
  guests_included INTEGER NOT NULL DEFAULT 1,

  -- Discounts (stored as factors: 0.90 = 10% off)
  weekly_price_factor REAL DEFAULT 1.0,
  monthly_price_factor REAL DEFAULT 1.0,

  -- Taxes (stored as JSON array)
  taxes JSON NOT NULL DEFAULT '[]',

  -- Terms
  min_nights INTEGER NOT NULL DEFAULT 1,
  max_nights INTEGER,
  check_in_time TEXT,                     -- e.g., '16:00'
  check_out_time TEXT,                    -- e.g., '11:00'

  -- Metadata
  active BOOLEAN NOT NULL DEFAULT 1,
  last_synced_at TEXT NOT NULL,           -- ISO 8601 timestamp
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_listings_active ON listings(active);
CREATE INDEX idx_listings_last_synced ON listings(last_synced_at);
```

**Taxes JSON Structure:**
```json
[
  {
    "id": "tax123",
    "type": "LOCAL_TAX",
    "amount": 10,
    "units": "PERCENTAGE",
    "quantifier": "PER_NIGHT",
    "appliedToAllFees": false,
    "appliedOnFees": ["AF", "CF"]
  }
]
```

---

### 2. availability

Stores daily availability and pricing for each listing.

```sql
CREATE TABLE availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  date TEXT NOT NULL,                     -- ISO 8601 date (YYYY-MM-DD) in property timezone
  status TEXT NOT NULL CHECK(status IN ('available', 'blocked', 'booked')),
  price REAL NOT NULL,                    -- Nightly rate for this date
  min_nights INTEGER NOT NULL DEFAULT 1,

  -- Restrictions
  closed_to_arrival BOOLEAN DEFAULT 0,    -- CTA: cannot check in
  closed_to_departure BOOLEAN DEFAULT 0,  -- CTD: cannot check out

  -- Block details (optional)
  block_type TEXT,                        -- 'reservation', 'owner', 'manual', 'maintenance'
  block_ref TEXT,                         -- Reference ID for the block

  -- Metadata
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  UNIQUE(listing_id, date)
);

CREATE INDEX idx_availability_listing_date ON availability(listing_id, date);
CREATE INDEX idx_availability_status ON availability(listing_id, status);
CREATE INDEX idx_availability_last_synced ON availability(last_synced_at);
```

**Status Values:**
- `available` - Can be booked
- `blocked` - Blocked by owner or maintenance
- `booked` - Existing reservation

---

### 3. quotes_cache

Caches complete price quotes for specific search criteria.

```sql
CREATE TABLE quotes_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  check_in TEXT NOT NULL,                 -- ISO 8601 date (YYYY-MM-DD)
  check_out TEXT NOT NULL,                -- ISO 8601 date (YYYY-MM-DD)
  guests INTEGER NOT NULL,

  -- Pricing breakdown
  nights INTEGER NOT NULL,
  currency TEXT NOT NULL,
  accommodation_fare REAL NOT NULL,       -- Total for all nights (after discounts)
  cleaning_fee REAL NOT NULL DEFAULT 0,
  extra_guest_fee REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  total_taxes REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL,

  -- Discount info
  discount_applied TEXT,                  -- 'weekly', 'monthly', or NULL
  discount_factor REAL,                   -- e.g., 0.90
  discount_savings REAL,                  -- Amount saved

  -- Full breakdown (stored as JSON for detailed display)
  breakdown JSON NOT NULL,

  -- Cache management
  expires_at TEXT NOT NULL,               -- ISO 8601 timestamp
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX idx_quotes_listing_dates ON quotes_cache(listing_id, check_in, check_out, guests);
CREATE INDEX idx_quotes_expires ON quotes_cache(expires_at);
```

**Breakdown JSON Structure:**
```json
{
  "nightlyRates": [
    {"date": "2025-04-15", "basePrice": 200, "adjustedPrice": 180}
  ],
  "accommodationFare": 1350,
  "fees": {
    "cleaning": 75,
    "extraGuest": 50
  },
  "taxes": [
    {"type": "LOCAL_TAX", "amount": 135, "description": "10% on accommodation"},
    {"type": "CITY_TAX", "amount": 105, "description": "€2.50 per guest per night"}
  ],
  "subtotal": 1475,
  "totalTaxes": 240,
  "total": 1715
}
```

---

## Field Mapping: Guesty → Internal

### Listings Table Mapping

| Internal Field | Guesty API Field | Transform/Notes |
|----------------|------------------|-----------------|
| `id` | `_id` | Direct copy |
| `title` | `title` | Direct copy |
| `accommodates` | `accommodates` | Direct copy (integer) |
| `bedrooms` | `bedrooms` | Direct copy |
| `bathrooms` | `bathrooms` | Direct copy (can be decimal, e.g., 2.5) |
| `property_type` | `propertyType` | Direct copy |
| `timezone` | `timezone` | Direct copy (IANA format) |
| `currency` | `prices.currency` | Direct copy |
| `base_price` | `prices.basePrice` | Direct copy |
| `weekend_base_price` | `prices.weekendBasePrice` | Direct copy (nullable) |
| `cleaning_fee` | `prices.cleaningFee` | Default to 0 if missing |
| `extra_person_fee` | `prices.extraPersonFee` | Default to 0 if missing |
| `guests_included` | `prices.guestsIncludedInRegularFee` | Default to 1 if missing |
| `weekly_price_factor` | `prices.weeklyPriceFactor` | Default to 1.0 if missing |
| `monthly_price_factor` | `prices.monthlyPriceFactor` | Default to 1.0 if missing |
| `taxes` | `taxes[]` | **Transform:** Map array to simplified JSON structure (see below) |
| `min_nights` | `terms.minNights` | Default to 1 if missing |
| `max_nights` | `terms.maxNights` | Nullable |
| `check_in_time` | `terms.checkInTime` | Direct copy (string like "16:00") |
| `check_out_time` | `terms.checkOutTime` | Direct copy (string like "11:00") |
| `active` | `active` && `listed` | Boolean AND operation |
| `last_synced_at` | N/A | Current UTC timestamp when synced |

**Tax Transform:**
```javascript
// Input: Guesty taxes array
const guestyTaxes = listing.taxes;

// Output: Simplified JSON for storage
const internalTaxes = guestyTaxes.map(tax => ({
  id: tax._id,
  type: tax.type,
  amount: tax.amount,
  units: tax.units,
  quantifier: tax.quantifier,
  appliedToAllFees: tax.appliedToAllFees || false,
  appliedOnFees: tax.appliedOnFees || []
}));

// Store as: JSON.stringify(internalTaxes)
```

---

### Availability Table Mapping

| Internal Field | Guesty API Field | Transform/Notes |
|----------------|------------------|-----------------|
| `listing_id` | `listingId` | Direct copy |
| `date` | `date` | Direct copy (YYYY-MM-DD format) |
| `status` | `status` | **Transform:** Map Guesty status to internal enum |
| `price` | `price` | Direct copy |
| `min_nights` | `minNights` | Direct copy |
| `closed_to_arrival` | `cta` | Direct copy (boolean) |
| `closed_to_departure` | `ctd` | Direct copy (boolean) |
| `block_type` | `blocks.*` | **Transform:** Derive from blocks object keys |
| `block_ref` | `blockRefs[0]` | First block reference if exists |
| `last_synced_at` | N/A | Current UTC timestamp when synced |

**Status Transform:**
```javascript
function mapStatus(guestyDay) {
  // Handle multi-unit properties
  const isAvailable = typeof guestyDay.allotment === 'number'
    ? guestyDay.allotment > 0
    : guestyDay.status === 'available';

  if (!isAvailable) {
    // Check if it's a reservation or owner block
    if (guestyDay.blocks?.reservation) return 'booked';
    return 'blocked';
  }

  return 'available';
}

function getBlockType(blocks) {
  if (!blocks) return null;
  if (blocks.reservation) return 'reservation';
  if (blocks.owner) return 'owner';
  if (blocks.manual) return 'manual';
  if (blocks.maintenance) return 'maintenance';
  return null;
}
```

---

### Quotes Cache Mapping

Quotes are **computed locally** from listings + availability data, not directly from Guesty API.

| Internal Field | Source | Calculation |
|----------------|--------|-------------|
| `listing_id` | Request parameter | Direct |
| `check_in` | Request parameter | Direct (YYYY-MM-DD) |
| `check_out` | Request parameter | Direct (YYYY-MM-DD) |
| `guests` | Request parameter | Direct (integer) |
| `nights` | Computed | `checkOut - checkIn` (days) |
| `currency` | `listings.currency` | From cached listing |
| `accommodation_fare` | Computed | Sum of nightly rates × discount factor |
| `cleaning_fee` | `listings.cleaning_fee` | From cached listing |
| `extra_guest_fee` | Computed | `(guests - guests_included) × extra_person_fee` |
| `subtotal` | Computed | `accommodation_fare + cleaning_fee + extra_guest_fee` |
| `total_taxes` | Computed | Sum of all calculated taxes |
| `total_price` | Computed | `subtotal + total_taxes` |
| `discount_applied` | Computed | 'weekly' if ≥7 nights, 'monthly' if ≥28 nights |
| `discount_factor` | Computed | From `weekly_price_factor` or `monthly_price_factor` |
| `discount_savings` | Computed | Original price - discounted price |
| `breakdown` | Computed | Full JSON structure with nightly breakdown |
| `expires_at` | Computed | `now() + 1 hour` (configurable) |

---

## Date & Timezone Handling Strategy

### Storage Strategy

**Decision: Store dates in property's local timezone, not UTC**

**Rationale:**
1. Guesty API returns calendar dates in property timezone (simple `YYYY-MM-DD`)
2. Check-in/check-out are always on calendar dates, not specific times
3. Avoids off-by-one errors from UTC conversion
4. Simpler queries: `WHERE date BETWEEN '2025-04-15' AND '2025-04-20'`

### Implementation Rules

1. **Calendar dates (`availability.date`):**
   - Format: `YYYY-MM-DD` (ISO 8601 date-only)
   - Timezone: Property's local timezone
   - Example: `2025-04-15` means April 15 in `Europe/Berlin` timezone

2. **Timestamps (`created_at`, `updated_at`, `expires_at`, `last_synced_at`):**
   - Format: ISO 8601 with UTC timezone
   - Example: `2025-04-15T14:30:00Z`
   - SQLite: Use `CURRENT_TIMESTAMP` for automatic UTC timestamps

3. **Timezone reference:**
   - Store in `listings.timezone` as IANA timezone string
   - Example: `Europe/Berlin`, `America/Los_Angeles`
   - Use for display formatting and time-based calculations

4. **Query considerations:**
   - Date range queries work directly: `date >= '2025-04-15' AND date <= '2025-04-22'`
   - No conversion needed for availability lookups
   - Convert to user's timezone only for display (frontend responsibility)

### Example: Date Flow

```
┌─────────────────────┐
│  Guesty API Call    │
│  Fetch calendar for │
│  2025-04-15 to      │
│  2025-04-22         │
└──────────┬──────────┘
           │
           │ Returns dates in property timezone
           ▼
┌─────────────────────┐
│  Internal Storage   │
│  availability table │
│  date: '2025-04-15' │ ◄── Stored as-is (no conversion)
│  (Europe/Berlin)    │
└──────────┬──────────┘
           │
           │ Query: SELECT * WHERE date BETWEEN...
           ▼
┌─────────────────────┐
│  API Response       │
│  Return dates       │
│  date: '2025-04-15' │ ◄── Return as-is
│  timezone: 'Europe/ │
│  Berlin'            │
└──────────┬──────────┘
           │
           │ Frontend converts for display
           ▼
┌─────────────────────┐
│  User's Browser     │
│  Display in user's  │
│  local timezone     │
│  (if needed)        │
└─────────────────────┘
```

### SQLite Date Functions

SQLite has limited native timezone support. For date arithmetic:

```sql
-- Add days to a date
SELECT DATE('2025-04-15', '+7 days');  -- Returns '2025-04-22'

-- Calculate difference in days
SELECT JULIANDAY('2025-04-22') - JULIANDAY('2025-04-15');  -- Returns 7.0

-- Current UTC timestamp
SELECT DATETIME('now');  -- Returns '2025-04-15T14:30:00'

-- Filter by date range
SELECT * FROM availability
WHERE date >= '2025-04-15'
  AND date < '2025-04-22'
ORDER BY date;
```

For timezone conversion (if needed), use application code with libraries like `luxon` or `date-fns-tz`.

---

## Cache Invalidation Strategy

### Listings Table
- **Sync Frequency:** Every 24 hours
- **Trigger:** Cron job at 3:00 AM property timezone
- **Invalidation:** Check `last_synced_at`, re-fetch if > 24 hours old

### Availability Table
- **Sync Frequency:** Every 4-6 hours
- **Trigger:** Cron job or on-demand when serving requests
- **Invalidation:** Delete rows where `last_synced_at > 6 hours ago`, re-fetch

### Quotes Cache
- **Sync Frequency:** N/A (computed on-demand)
- **Invalidation:** Check `expires_at`, delete if expired
- **TTL:** 1 hour (configurable)
- **Cleanup:** Periodic job to `DELETE FROM quotes_cache WHERE expires_at < now()`

---

## Query Patterns

### Get Availability for Date Range
```sql
SELECT date, status, price, min_nights, closed_to_arrival, closed_to_departure
FROM availability
WHERE listing_id = ?
  AND date >= ?
  AND date <= ?
ORDER BY date ASC;
```

### Check if Dates Available for Booking
```sql
SELECT COUNT(*) as unavailable_count
FROM availability
WHERE listing_id = ?
  AND date >= ?
  AND date < ?  -- Check-out date is exclusive
  AND (status != 'available' OR closed_to_arrival = 1);
```

### Get Cached Quote
```sql
SELECT *
FROM quotes_cache
WHERE listing_id = ?
  AND check_in = ?
  AND check_out = ?
  AND guests = ?
  AND expires_at > datetime('now')
LIMIT 1;
```

### Cleanup Expired Quotes
```sql
DELETE FROM quotes_cache
WHERE expires_at < datetime('now');
```

---

## Summary

✅ **Listings table** - Stores property details, pricing config, taxes
✅ **Availability table** - Daily availability, pricing, min stay requirements
✅ **Quotes cache table** - Computed price quotes with TTL
✅ **Field mapping** - Complete Guesty → Internal transformation rules
✅ **Date strategy** - Store in property timezone, timestamps in UTC

This schema is optimized for:
- Fast read queries (proper indexes)
- Simple date range filtering (no timezone conversion)
- Cache invalidation (timestamps for staleness checks)
- MVP scope (minimal fields, room to extend)