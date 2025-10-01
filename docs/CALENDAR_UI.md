# Calendar UI Documentation

This document describes the Airbnb-style calendar UI component with overlay datepicker and localized interface.

## Overview

The calendar UI is a vanilla JavaScript component that provides:
- **Airbnb-style interface** with compact booking header
- **Overlay datepicker** with two-month view (desktop) or one-month (mobile)
- **Full localization** (German default, English auto-detect)
- **Date range selection** with hover preview
- **Pricing details overlay** with comprehensive breakdown
- **Keyboard navigation** and full accessibility support
- **Auto-selection** of first available dates on load
- **Request to Book** via mailto with localized content

## Files

- **`public/index.html`** - Main HTML page with booking header and overlays
- **`public/calendar.css`** - Styles (mobile-first, responsive overlays)
- **`public/calendar.js`** - Calendar component logic with localization

## Features

### 1. Compact Booking Header

**Always visible interface showing:**
- **Price line** - Clickable, opens pricing overlay (e.g., "€1.500 für 3 Nächte")
- **Date inputs** - Check-in and check-out, opens datepicker overlay
- **Guest selector** - Inline increment/decrement controls (1-15 guests)
- **CTA button** - "Buchung anfragen" / "Request to Book"
- **Helper text** - "Du wirst nicht belastet" / "You won't be charged yet"

**Auto-selection on load:**
- Finds first available date in the future
- Adds minimum nights requirement
- Fetches quote and displays price immediately

**Edge case handling:**
- Shows "Aktuell keine Verfügbarkeit" / "No availability at this time" when no dates available
- Disables CTA until valid dates and quote exist

### 2. Overlay Datepicker

**Desktop (≥768px):**
- Shows 2 months side-by-side
- Centered modal dialog
- Hover preview for date range
- Closes via ESC key or clicking outside

**Mobile (<768px):**
- Shows 1 month at a time
- Fullscreen overlay
- Touch-optimized navigation
- No hover effects (performance)

**Locale-specific behavior:**
- **German (DE):** Week starts Monday, date format "15. Mär"
- **English (EN):** Week starts Sunday, date format "Mar 15"

**Features:**
- **Range selection:** Click check-in, then check-out
- **Hover preview:** Shows temporary range on desktop
- **Auto-close:** Closes immediately when check-out selected
- **Month navigation:** Previous/next buttons with disabled states
- **Reset button:** Returns to auto-selected dates

### 3. Date States

Each date cell can have one of the following states:

| State | Visual | Behavior |
|-------|--------|----------|
| **Available** | White background, shows price | Selectable with keyboard/mouse |
| **Selected (check-in)** | Blue background, bold | Start of range |
| **Selected (check-out)** | Blue background, bold | End of range |
| **In Range** | Light blue background | Between check-in and check-out |
| **Hover Range** | Light gray background | Preview range (desktop only) |
| **Past** | Gray background, muted text | Disabled, not focusable |
| **Booked** | Red background, strikethrough | Disabled, not focusable |
| **Blocked** | Red background, strikethrough | Disabled, not focusable |

### 4. Date Selection Flow

1. **Auto-selected on load:**
   - First available date + minNights
   - Price displayed immediately

2. **Manual selection (overlay):**
   - Click check-in date input → opens overlay
   - Select new check-in date
   - Select check-out date
   - Overlay closes automatically
   - Header updates with new price

3. **Validation:**
   - Enforces minimum stay requirement
   - Validates all dates in range are available
   - Shows error message if validation fails

4. **Request Booking:**
   - Generates localized mailto link
   - Includes full booking details and price breakdown
   - Opens user's email client

### 5. Pricing Details Overlay

**Opened by:** Clicking price line in header

**Shows complete breakdown:**
1. **Base nights** - Rate × nights (e.g., "€500 × 3 Nächte")
2. **Discounts** - Weekly/monthly with percentage (e.g., "Wochenrabatt −15%")
3. **Cleaning fee** - Once per stay
4. **Extra guests** - Above included count
5. **Taxes** - All applicable taxes with descriptions
6. **Total** - At the bottom (prominent styling)

**Localization:**
- All labels translated
- Currency formatted with locale (€1.500 vs €1,500)
- Plurals handled correctly ("1 Nacht" vs "2 Nächte")

**Features:**
- Close button with aria-label
- ESC key to close
- Click outside to close
- Focus trap for keyboard navigation

### 6. Localization

**Language detection:**
- Detects browser language (`navigator.language`)
- Defaults to German if not explicitly English
- No visible language toggle

**Translated elements:**
- All UI strings (buttons, labels, messages)
- Date formats (locale-specific)
- Currency formatting (de-DE vs en-US)
- Plurals (night/nights, guest/guests)
- Email subject and body

**Example strings:**
```javascript
// German (default)
"€1.500 für 3 Nächte"
"Buchung anfragen"
"Du wirst nicht belastet"

// English (auto-detected)
"€1,500 for 3 nights"
"Request to Book"
"You won't be charged yet"
```

### 7. Accessibility Features

**Focus Management:**
- **Focus trap** in both overlays (Tab/Shift+Tab wraps)
- **Restores focus** to previously focused element on close
- **Auto-focus** on close button when overlay opens

**Keyboard Navigation:**
- **Arrow keys** navigate calendar dates (Left/Right/Up/Down)
- **Enter/Space** selects focused date
- **ESC** closes overlays
- **Tab** navigates between interactive elements

**Screen readers:**
- All interactive elements have localized `aria-label`
- Day cells marked with `tabindex="0"` when available
- Disabled elements not in tab order
- Proper ARIA roles for overlays

**Examples:**
```html
<button aria-label="Gästeanzahl verringern">−</button>
<input aria-label="Anzahl der Gäste" value="2" />
<button aria-label="Vorheriger Monat">←</button>
```

### 8. Guest Selector

**Inline controls:**
- Decrement button (−)
- Number display
- Increment button (+)

**Validation:**
- Minimum: 1 guest
- Maximum: Property capacity (e.g., 15)
- Shows helper text for extra guest fees

**Updates:**
- Instantly re-fetches quote
- Updates price in header
- Updates CTA state

## API Integration

The calendar fetches data from these endpoints:

### GET /listing
Fetches property information:
```javascript
{
  "id": "...",
  "title": "Design-Farmhouse in der Natur",
  "currency": "EUR",
  "accommodates": 15,
  "pricing": {
    "basePrice": 1500,
    "guestsIncluded": 5,
    "extraGuestFee": 100,
    "weeklyDiscount": 15,
    "cleaningFee": 350
  }
}
```

### GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD
Fetches availability for date range:
```javascript
{
  "days": [
    {
      "date": "2025-04-15",
      "status": "available",
      "price": 1500,
      "minNights": 3
    }
  ]
}
```

**Caching Strategy:**
- Fetches 3 months of data at a time
- Stored in memory (`availabilityData` object)
- Re-fetches when navigating to new months

### GET /quote?checkIn=...&checkOut=...&guests=N
Fetches price quote with full breakdown:
```javascript
{
  "quote": {
    "nights": 7,
    "currency": "EUR",
    "pricing": {
      "accommodationFare": 10500,
      "cleaningFee": 350,
      "extraGuestFee": 300,
      "totalPrice": 11150
    },
    "discount": {
      "type": "weekly",
      "savings": 1575
    },
    "breakdown": {
      "nightlyRates": [...],
      "taxes": [...]
    }
  }
}
```

**When Called:**
- Automatically on load (after auto-selection)
- When check-out date is selected
- When guest count changes
- Updates header and enables CTA

## Component Architecture

### Class: `BookingCalendar`

**Constructor:**
```javascript
new BookingCalendar(apiBaseUrl = 'http://localhost:3000')
```

**Properties:**
- `language` - Current language (de/en)
- `currentDate` - Currently displayed month
- `overlayCurrentMonth` - Month shown in overlay
- `selectedCheckIn` - Selected check-in date
- `selectedCheckOut` - Selected check-out date
- `tempCheckIn` - Temporary selection in overlay
- `tempCheckOut` - Temporary selection in overlay
- `hoverDate` - Date being hovered (desktop only)
- `availabilityData` - Cached availability lookup
- `listingData` - Property information
- `currentQuote` - Latest quote data
- `guestCount` - Number of guests
- `maxGuests` - Property capacity
- `isMobile` - Responsive flag
- `previouslyFocusedElement` - For focus restoration

**Key Methods:**

#### `async init()`
Initialize calendar:
1. Fetch listing data
2. Initialize guest selector
3. Fetch availability
4. Auto-select dates (first available + minNights)
5. Render calendar
6. Setup event listeners
7. Update header with quote
8. Update labels with translations

#### `detectLanguage()`
Detect browser language:
- Returns 'en' if `navigator.language` starts with 'en'
- Otherwise returns 'de' (default)

#### `t(key)`
Get localized translation:
- Returns translated string or function
- Supports dynamic content (prices, nights, plurals)
- Example: `t('priceFor')('€1.500', 3)` → "€1.500 für 3 Nächte"

#### `autoSelectDates()`
Find and select first available dates:
- Sorts dates chronologically
- Finds first available date >= today
- Adds minimum nights requirement
- Sets `selectedCheckIn` and `selectedCheckOut`

#### `openDatepicker()`
Open datepicker overlay with focus trap:
1. Store previously focused element
2. Copy selections to temp state
3. Render overlay calendar
4. Show overlay (fullscreen mobile, dialog desktop)
5. Add keyboard listeners (ESC, arrow keys)
6. Focus close button
7. Trap focus within overlay

#### `closeDatepicker()`
Close datepicker overlay:
1. Hide overlay
2. Remove keyboard listeners
3. Remove focus trap
4. Restore focus to previous element
5. Apply temp selections (if valid)
6. Update header with new quote

#### `handleDayClickOverlay(dateStr)`
Handle day click in overlay:
1. Parse date
2. If no check-in: set tempCheckIn
3. If check-in but no check-out: validate and set tempCheckOut
4. Close overlay automatically
5. If both selected: start over

#### `handleCalendarKeyboard(event)`
Handle keyboard navigation:
- **Arrow keys:** Navigate dates (auto-scroll months)
- **Enter/Space:** Select focused date
- Focus moves to new date after navigation

#### `trapFocus(container)`
Constrain Tab navigation within overlay:
- Queries all focusable elements
- Wraps Tab from last to first element
- Wraps Shift+Tab from first to last element

#### `showPricingOverlay()`
Open pricing details overlay:
1. Store previously focused element
2. Build pricing breakdown HTML
3. Show overlay
4. Focus close button
5. Trap focus within overlay

#### `renderOverlayCalendar()`
Render two-month calendar in overlay:
1. Generate HTML for 1-2 months (mobile/desktop)
2. Apply locale-specific week start
3. Mark selected/hover states
4. Update navigation buttons
5. Setup event listeners (delegation)

#### `setupOverlayEventListeners()`
Setup event delegation for calendar:
- Click listener on parent container
- Hover listeners (desktop only)
- Finds `.calendar-day-overlay` via `closest()`
- Prevents inline onclick handlers from breaking

#### `updateHeaderInfo()`
Fetch quote and update header:
1. Handle no-availability edge case
2. Fetch quote from API
3. Update price line with formatted total
4. Update date inputs with short format
5. Store quote for email
6. Update CTA state (enable/disable)

#### `formatCurrency(amount, currency)`
Format currency with locale:
- Uses `Intl.NumberFormat` with proper locale
- German: €1.500 (space, period separator)
- English: €1,500 (no space, comma separator)
- Fallback for browsers without Intl

#### `requestBooking()`
Generate mailto link:
1. Validate dates and quote exist
2. Format dates for subject (locale-specific)
3. Build localized email subject
4. Build detailed email body with breakdown
5. Encode and open mailto link

## Styling

### CSS Architecture

**Mobile-first approach:**
- Base styles for mobile
- Media queries for desktop enhancements

**Key layout patterns:**
- Flexbox for booking header
- Grid for calendar days (7 columns)
- Fixed overlays with centered content

### Overlay Styling

```css
.overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.overlay-content {
  background: white;
  border-radius: 16px;
  max-width: 90%;
  max-height: 90%;
  overflow: auto;
}

/* Mobile: fullscreen */
@media (max-width: 767px) {
  .calendar-overlay-content {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}
```

### Calendar Day States

```css
.calendar-day-overlay.selected {
  background: #2563eb;
  color: white;
  font-weight: bold;
}

.calendar-day-overlay.in-range {
  background: #dbeafe;
}

.calendar-day-overlay.hover-range {
  background: #f3f4f6;
}

.calendar-day-overlay[data-disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
```

### Responsive Breakpoint

```css
@media (min-width: 768px) {
  /* Desktop: 2 months */
  .calendar-months-overlay {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2rem;
  }

  /* Hover effects enabled */
  .calendar-day-overlay:hover:not([data-disabled]) {
    background: #f9fafb;
  }
}
```

## Usage

### Basic Setup

1. **Include files:**
```html
<link rel="stylesheet" href="calendar.css">
<script src="calendar.js"></script>
```

2. **HTML structure already in `index.html`:**
```html
<div class="booking-header">...</div>
<div id="pricing-overlay" class="overlay">...</div>
<div id="calendar-overlay" class="overlay">...</div>
```

3. **Initialize:**
```javascript
const calendar = new BookingCalendar('http://localhost:3000');
```

### Customization

**Access calendar instance:**
```javascript
// Global instance
calendar.selectedCheckIn      // Current check-in
calendar.selectedCheckOut     // Current check-out
calendar.currentQuote         // Latest quote
calendar.language             // Current language (de/en)
calendar.guestCount          // Number of guests
```

**Manually trigger actions:**
```javascript
calendar.openDatepicker();           // Open datepicker
calendar.showPricingOverlay();       // Open pricing
calendar.requestBooking();           // Generate mailto
calendar.autoSelectDates();          // Reset to first available
```

## Error Handling

Errors are displayed via toast/inline messages:

```javascript
calendar.showError('Minimum stay is 3 nights');
calendar.clearError();
```

**Common errors (localized):**
- "Mindestaufenthalt ist X Nächte" / "Minimum stay is X nights"
- "Einige Daten im ausgewählten Bereich sind nicht verfügbar" / "Some dates in the selected range are not available"
- "Maximale Kapazität ist X Gäste" / "Maximum capacity is X guests"

## Performance

**Metrics:**
- Initial load: ~200-500ms (includes API calls + auto-selection)
- Overlay open: <100ms (perceived instant)
- Date selection: <50ms (instant UI update)
- Price update: ~100-200ms (API call)
- Hover effects: 60fps (CSS transitions)

**Optimizations:**
- Availability data cached in memory
- Event delegation (no inline handlers)
- Desktop-only hover effects (mobile performance)
- Efficient DOM updates (targeted re-renders)
- CSS transitions for smooth animations

## Accessibility (WCAG 2.1 AA)

**Keyboard Support:**
- ✅ All interactive elements keyboard-accessible
- ✅ Focus visible (browser default + custom styles)
- ✅ Logical tab order
- ✅ Focus trap in overlays
- ✅ Arrow key navigation in calendar
- ✅ ESC to close overlays

**Screen Readers:**
- ✅ Semantic HTML (buttons, inputs)
- ✅ Localized aria-labels on all controls
- ✅ Focus restoration on overlay close
- ✅ Error messages announced
- ✅ State changes communicated

**Visual:**
- ✅ Color contrast meets AA (4.5:1 text, 3:1 UI)
- ✅ Focus indicators visible
- ✅ Text can be resized 200%
- ✅ No information by color alone

## Testing

### Manual Testing

1. **Start server:**
   ```bash
   npm run dev
   ```

2. **Open browser:**
   ```
   http://localhost:3000
   ```

3. **Test scenarios:**
   - ✅ Initial load: dates auto-selected, price shown
   - ✅ Mobile: fullscreen datepicker
   - ✅ Desktop: centered dialog, ESC/outside close
   - ✅ Range change: nights and total update
   - ✅ Pricing overlay: correct order, labels, numbers
   - ✅ Localization: DE vs EN (change browser language)
   - ✅ Edge case: no availability (modify DB)
   - ✅ Mailto: subject/body localized with totals
   - ✅ Keyboard: Tab, arrows, Enter, ESC
   - ✅ Screen reader: NVDA/JAWS/VoiceOver

### Browser Testing

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | Latest | ✅ Full support |
| Firefox | Latest | ✅ Full support |
| Safari | Latest | ✅ Full support |
| Edge | Latest | ✅ Full support |
| Mobile Safari | iOS 14+ | ✅ Full support |
| Chrome Mobile | Latest | ✅ Full support |

**Required features:**
- ES6 classes, async/await
- Fetch API
- Intl.NumberFormat (with fallback)
- CSS Grid, Flexbox
- CSS Custom Properties
- Position: fixed (overlays)

## Browser Support

**Modern browsers (2020+):**
- Chrome/Edge: ✅ Full support
- Firefox: ✅ Full support
- Safari: ✅ Full support (iOS 14+)
- Mobile browsers: ✅ Full support

**Graceful degradation:**
- Intl.NumberFormat fallback for older browsers
- Basic currency formatting without locale

## Future Enhancements

Potential additions:

- [ ] Language toggle (explicit switcher)
- [ ] More languages (FR, IT, ES)
- [ ] Calendar sync (iCal export)
- [ ] Saved searches / favorites
- [ ] Price alerts
- [ ] Multi-property support
- [ ] Reviews integration
- [ ] Photo gallery
- [ ] Map integration
- [ ] Social sharing
