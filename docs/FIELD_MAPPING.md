# Field Mapping Reference

Quick reference for mapping Guesty API fields to internal database fields.

## Listings Mapping

| Internal Field | Guesty Field | Transform | Default |
|----------------|--------------|-----------|---------|
| `id` | `_id` | Direct | - |
| `title` | `title` | Direct | - |
| `accommodates` | `accommodates` | Direct | - |
| `bedrooms` | `bedrooms` | Direct | `null` |
| `bathrooms` | `bathrooms` | Direct | `null` |
| `property_type` | `propertyType` | Direct | `null` |
| `timezone` | `timezone` | Direct | - |
| `currency` | `prices.currency` | Direct | - |
| `base_price` | `prices.basePrice` | Direct | - |
| `weekend_base_price` | `prices.weekendBasePrice` | Direct | `null` |
| `cleaning_fee` | `prices.cleaningFee` | Direct | `0` |
| `extra_person_fee` | `prices.extraPersonFee` | Direct | `0` |
| `guests_included` | `prices.guestsIncludedInRegularFee` | Direct | `1` |
| `weekly_price_factor` | `prices.weeklyPriceFactor` | Direct | `1.0` |
| `monthly_price_factor` | `prices.monthlyPriceFactor` | Direct | `1.0` |
| `taxes` | `taxes[]` | Map array → JSON | `[]` |
| `min_nights` | `terms.minNights` | Direct | `1` |
| `max_nights` | `terms.maxNights` | Direct | `null` |
| `check_in_time` | `terms.checkInTime` | Direct | `null` |
| `check_out_time` | `terms.checkOutTime` | Direct | `null` |
| `active` | `active && listed` | Boolean AND | `true` |
| `last_synced_at` | - | `new Date().toISOString()` | - |

### Tax Transform

```typescript
// Input: Guesty tax object
{
  "_id": "tax123",
  "type": "LOCAL_TAX",
  "amount": 10,
  "units": "PERCENTAGE",
  "quantifier": "PER_NIGHT",
  "appliedToAllFees": false,
  "appliedOnFees": ["AF", "CF"],
  "isAppliedByDefault": true,
  "appliedByDefaultOnChannels": []
}

// Output: Internal tax object
{
  "id": "tax123",
  "type": "LOCAL_TAX",
  "amount": 10,
  "units": "PERCENTAGE",
  "quantifier": "PER_NIGHT",
  "appliedToAllFees": false,
  "appliedOnFees": ["AF", "CF"]
}
```

---

## Availability Mapping

| Internal Field | Guesty Field | Transform | Default |
|----------------|--------------|-----------|---------|
| `listing_id` | `listingId` | Direct | - |
| `date` | `date` | Direct (YYYY-MM-DD) | - |
| `status` | `status` + `allotment` + `blocks` | **Complex** (see below) | - |
| `price` | `price` | Direct | - |
| `min_nights` | `minNights` | Direct | `1` |
| `closed_to_arrival` | `cta` | Direct | `false` |
| `closed_to_departure` | `ctd` | Direct | `false` |
| `block_type` | `blocks.*` | Extract key (see below) | `null` |
| `block_ref` | `blockRefs[0]` | First element | `null` |
| `last_synced_at` | - | `new Date().toISOString()` | - |

### Status Transform

```typescript
function mapStatus(guestyDay) {
  // Multi-unit: check allotment first
  const isAvailable = typeof guestyDay.allotment === 'number'
    ? guestyDay.allotment > 0
    : guestyDay.status === 'available';

  if (!isAvailable) {
    // Distinguish between booked and blocked
    if (guestyDay.blocks?.reservation) return 'booked';
    return 'blocked';
  }

  return 'available';
}
```

### Block Type Transform

```typescript
function getBlockType(blocks) {
  if (!blocks) return null;
  if (blocks.reservation) return 'reservation';
  if (blocks.owner) return 'owner';
  if (blocks.maintenance) return 'maintenance';
  if (blocks.manual) return 'manual';
  return null;
}
```

---

## Quotes Mapping

Quotes are **computed locally** from listings + availability data, not directly mapped from Guesty API.

### Input Sources

1. **Request parameters:**
   - `listing_id`
   - `check_in` (date string)
   - `check_out` (date string)
   - `guests` (integer)

2. **From `listings` table:**
   - `currency`
   - `cleaning_fee`
   - `extra_person_fee`
   - `guests_included`
   - `weekly_price_factor`
   - `monthly_price_factor`
   - `taxes` (JSON)

3. **From `availability` table:**
   - `price` (for each night in range)
   - `status` (to validate all dates are available)
   - `min_nights` (to validate minimum stay)

### Calculation Steps

1. **Nights:** `checkOut - checkIn` (days)
2. **Accommodation fare:** Sum of nightly prices × discount factor
3. **Extra guest fee:** `max(0, guests - guests_included) × extra_person_fee`
4. **Cleaning fee:** From listing (once per stay)
5. **Subtotal:** `accommodation_fare + extra_guest_fee + cleaning_fee`
6. **Taxes:** Apply each tax based on its rules
7. **Total:** `subtotal + total_taxes`

### Discount Factor

```typescript
function getDiscountFactor(nights, listing) {
  if (nights >= 28) return listing.monthly_price_factor;
  if (nights >= 7) return listing.weekly_price_factor;
  return 1.0;
}
```

---

## Date & Timezone Strategy

### Storage Format

- **Calendar dates:** `YYYY-MM-DD` in property's local timezone (from `listing.timezone`)
- **Timestamps:** ISO 8601 with UTC (`YYYY-MM-DDTHH:mm:ssZ`)

### Examples

```typescript
// Calendar date (in property timezone)
availability.date = '2025-04-15'; // April 15 in Europe/Berlin

// Timestamp (UTC)
listing.last_synced_at = '2025-04-15T14:30:00Z'; // 2:30 PM UTC

// No conversion needed for queries
SELECT * FROM availability
WHERE date >= '2025-04-15' AND date <= '2025-04-22';
```

### Key Points

1. **No timezone conversion** for calendar dates
2. **Property timezone stored** in `listings.timezone` for reference
3. **Frontend handles** user timezone display if needed
4. **SQLite date functions** work directly with `YYYY-MM-DD` format

---

## Implementation Files

- **Type definitions:** `src/types/models.ts`, `src/types/guesty.ts`
- **Listing mapper:** `src/mappers/listing-mapper.ts`
- **Availability mapper:** `src/mappers/availability-mapper.ts`
- **Database schema:** `schema.sql`
- **Full documentation:** `docs/DATA_MODEL.md`