# Guesty API Fixtures

This directory contains sanitized JSON fixtures representing common scenarios when working with the Guesty API. These fixtures are based on the Farmhouse Prasser property and demonstrate various booking scenarios, pricing calculations, and edge cases.

## Files

### Listing Data

- **`listing-response.json`** - Complete listing/property details including pricing configuration, taxes, amenities, and capacity

### Calendar Data

- **`calendar-available-dates.json`** - Available dates showing standard weekday pricing and weekend pricing
- **`calendar-blocked-dates.json`** - Blocked/unavailable dates with different block types (reservation, owner, maintenance)

### Quote/Pricing Scenarios

- **`quote-standard-stay.json`** - Standard 3-night weekday stay with 4 guests (no extra fees, no discounts)
- **`quote-weekly-discount.json`** - 7-night stay with 6 guests, includes weekly discount and extra guest fees
- **`quote-peak-season.json`** - 5-night peak season stay with increased rates and minimum stay requirement
- **`quote-over-capacity.json`** - Error case: 10 guests requested but property only accommodates 8

## Property Configuration Summary

**Farmhouse Prasser** (`farmhouse-prasser-001`)
- **Accommodates:** 8 guests
- **Base Price:** €200/night (weekday), €250/night (weekend)
- **Cleaning Fee:** €75 (once per stay)
- **Extra Guest Fee:** €25/guest (beyond 4 included guests)
- **Weekly Discount:** 10% off (7+ nights, `weeklyPriceFactor: 0.90`)
- **Monthly Discount:** 15% off (28+ nights, `monthlyPriceFactor: 0.85`)
- **Minimum Stay:** 2 nights (higher during peak season)
- **Currency:** EUR
- **Timezone:** Europe/Berlin

### Taxes

1. **Local Tax:** 10% on accommodation fare per night
2. **City Tax:** €2.50 per guest per night (fixed)

## Scenario Breakdown

### 1. Standard Stay (quote-standard-stay.json)
- **Dates:** April 15-18, 2025 (3 nights, weekdays)
- **Guests:** 4 (included in base price)
- **Calculation:**
  - Accommodation: 3 nights × €200 = €600
  - Cleaning Fee: €75
  - Extra Guest Fee: €0
  - Subtotal: €675
  - Local Tax (10% on accommodation): €60
  - City Tax (€2.50 × 4 guests × 3 nights): €30
  - **Total: €765**

### 2. Weekly Discount Stay (quote-weekly-discount.json)
- **Dates:** April 15-22, 2025 (7 nights, includes weekend)
- **Guests:** 6 (2 extra guests)
- **Calculation:**
  - Base Accommodation (before discount):
    - 5 weekdays × €200 = €1,000
    - 2 weekend nights × €250 = €500
    - Subtotal: €1,500
  - Weekly Discount (10% off): €1,500 × 0.90 = €1,350
  - Cleaning Fee: €75
  - Extra Guest Fee: 2 × €25 = €50
  - Subtotal: €1,475
  - Local Tax (10% on accommodation): €135
  - City Tax (€2.50 × 6 guests × 7 nights): €105
  - **Total: €1,715**
  - **Savings from weekly discount: €150**

### 3. Peak Season Stay (quote-peak-season.json)
- **Dates:** July 25-30, 2025 (5 nights, summer peak)
- **Guests:** 4 (included in base price)
- **Special Conditions:**
  - Higher base rates (€280 weekday, €320 weekend)
  - Increased minimum stay (5 nights)
- **Calculation:**
  - Accommodation:
    - 1 Friday × €280 = €280
    - 1 Saturday × €320 = €320
    - 3 other nights × €280 = €840
    - Total: €1,440
  - Cleaning Fee: €75
  - Extra Guest Fee: €0
  - Subtotal: €1,515
  - Local Tax (10% on accommodation): €144
  - City Tax (€2.50 × 4 guests × 5 nights): €50
  - **Total: €1,709**

### 4. Over Capacity Error (quote-over-capacity.json)
- **Dates:** May 10-13, 2025 (3 nights)
- **Guests:** 10 (exceeds max of 8)
- **Result:** Error response
- **Validation:** Client should prevent this request before API call

## Usage

These fixtures can be used for:

1. **Testing** - Unit and integration tests for pricing calculations
2. **Development** - Mock API responses during frontend development
3. **Documentation** - Examples of expected API response structures
4. **Validation** - Verify pricing logic against known scenarios

## Notes

- All monetary values are in EUR
- Dates use `YYYY-MM-DD` format (ISO 8601 date-only)
- Weekend pricing applies to Friday and Saturday nights
- Weekly discount applies to stays of 7+ nights
- Monthly discount applies to stays of 28+ nights
- Extra guest fees apply to guests beyond `guestsIncludedInRegularFee` (4)
- Minimum stay requirements can vary by date (higher during peak seasons)
- Taxes are calculated on accommodation fare and applied according to their specific rules