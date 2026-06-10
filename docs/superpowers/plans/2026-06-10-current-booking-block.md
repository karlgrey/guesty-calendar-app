# Current-Booking Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show currently in-house bookings in a dedicated, always-visible "Aktuell belegt" block in the admin panel (with quote/invoice actions), and count them in the future-period stats.

**Architecture:** A new `getCurrentReservations` repo function feeds an always-rendered block above the bookings table; `getDashboardStats('future')` is widened to count not-yet-ended stays; the booking-row renderer is extracted to a shared JS function reused by the list and the block. `getReservationsByPeriod` is untouched (BI/weekly/GCal keep their "future = real arrivals" semantics).

**Tech Stack:** TypeScript (ESM `.js` imports), better-sqlite3, Express, Vitest. Spec: `docs/superpowers/specs/2026-06-10-current-booking-block-design.md`.

**Conventions:** ESM `.js` imports; `npx vitest run <path>`; ESLint `no-unused-vars` enforced; end green.

---

## Task 1: `getCurrentReservations` repo function

**Files:**
- Modify: `src/repositories/reservation-repository.ts`
- Test: `src/repositories/current-reservations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/repositories/current-reservations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getCurrentReservations } from './reservation-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE reservations (
    id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT,
    check_in TEXT, check_out TEXT, status TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function ins(reservation_id: string, checkInExpr: string, checkOutExpr: string, status = 'confirmed') {
  db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status)
    VALUES (?, 'A', date('now', ?), date('now', ?), ?)`).run(reservation_id, checkInExpr, checkOutExpr, status);
}

describe('getCurrentReservations', () => {
  it('returns only in-house stays (check_in <= today < check_out, active status)', () => {
    ins('current', '-1 day', '+1 day');        // in-house now -> included
    ins('future', '+2 day', '+5 day');         // not started -> excluded
    ins('past', '-5 day', '-1 day');           // ended -> excluded
    ins('leaves-today', '-3 day', '+0 day');   // checkout today -> excluded
    ins('cancelled-current', '-1 day', '+1 day', 'canceled'); // active-status filter -> excluded
    const ids = getCurrentReservations('A').map((r) => r.reservation_id);
    expect(ids).toEqual(['current']);
  });

  it('returns [] for a listing with no current stays', () => {
    ins('future', '+2 day', '+5 day');
    expect(getCurrentReservations('B')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/current-reservations.test.ts`
Expected: FAIL — `getCurrentReservations` not exported.

- [ ] **Step 3: Implement**

In `src/repositories/reservation-repository.ts`, add next to `getReservationsByPeriod` (it uses the existing `rowToReservation` mapper and `ReservationRow` type already imported in the file):

```typescript
/**
 * Currently in-house reservations: checked in on/before today and not yet
 * checked out (check_out strictly after today). Active statuses only.
 * Separate from getReservationsByPeriod so the period semantics used by
 * BI/weekly/calendar (future = real arrivals) stay unchanged.
 */
export function getCurrentReservations(listingId: string): Reservation[] {
  const db = getDatabase();
  try {
    const rows = db
      .prepare(
        `SELECT * FROM reservations
         WHERE listing_id = ?
           AND date(check_in) <= date('now')
           AND date(check_out) > date('now')
           AND status IN ('confirmed','reserved')
         ORDER BY check_in ASC`
      )
      .all(listingId) as ReservationRow[];
    return rows.map(rowToReservation);
  } catch (error) {
    logger.error({ error, listingId }, 'Failed to get current reservations');
    throw new DatabaseError(
      `Failed to get current reservations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
```

(If `Reservation`, `DatabaseError`, `logger`, `ReservationRow`, `rowToReservation` aren't already imported in this file, they are — `getReservationsByPeriod`/`getUpcomingReservations` use them. Reuse the same imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/current-reservations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repositories/reservation-repository.ts src/repositories/current-reservations.test.ts
git commit -m "feat(admin): getCurrentReservations (in-house stays)"
```

---

## Task 2: Count in-house stays in future-period stats

**Files:**
- Modify: `src/repositories/availability-repository.ts` (`getDashboardStats`)
- Test: `src/repositories/dashboard-stats-current.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/repositories/dashboard-stats-current.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getDashboardStats } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT, check_in TEXT, check_out TEXT, status TEXT, host_payout REAL, total_price REAL);
    CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT);
  `);
  setDatabase(db);
  // one in-house stay: checked in yesterday, leaves tomorrow, 500 payout
  db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,host_payout,total_price)
    VALUES ('cur','A', date('now','-1 day'), date('now','+1 day'), 'confirmed', 500, 600)`).run();
});
afterEach(() => { resetDatabase(); db.close(); });

describe("getDashboardStats — in-house stay counts in 'future'", () => {
  it('future stats count the in-house booking', () => {
    const s = getDashboardStats('A', 365, 'future');
    expect(s.totalBookings).toBe(1);
    expect(s.totalRevenue).toBe(500);
  });

  it("past stats do NOT count the in-house booking", () => {
    const s = getDashboardStats('A', 365, 'past');
    expect(s.totalBookings).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/dashboard-stats-current.test.ts`
Expected: FAIL — current `'future'` revenue query filters `check_in >= date('now')`, so the in-house booking (check_in yesterday) is not counted (`totalBookings` 0).

- [ ] **Step 3: Implement**

In `src/repositories/availability-repository.ts`, in `getDashboardStats`, the `'future'` revenue branch currently reads:
```typescript
      revenueQuery = `SELECT
        COUNT(*) as total_bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as total_revenue
      FROM reservations
      WHERE listing_id = ?
      AND check_in >= date('now')`;
```
Change the WHERE to count not-yet-ended stays (current + future):
```typescript
      revenueQuery = `SELECT
        COUNT(*) as total_bookings,
        SUM(COALESCE(host_payout, total_price, 0)) as total_revenue
      FROM reservations
      WHERE listing_id = ?
      AND date(check_out) > date('now')`;
```
Leave the `'past'` branch unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/dashboard-stats-current.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run` (no regression) and `npx eslint src/repositories/availability-repository.ts src/repositories/dashboard-stats-current.test.ts src/repositories/current-reservations.test.ts`.

```bash
git add src/repositories/availability-repository.ts src/repositories/dashboard-stats-current.test.ts
git commit -m "feat(admin): count in-house stays in future-period dashboard stats"
```

---

## Task 3: Endpoint + frontend block

**Files:**
- Modify: `src/routes/admin.ts`

No unit test (inline-HTML frontend + Express handler; verified by tsc + manual render). 3 edits.

- [ ] **Step 1: Import + endpoint returns `currentBookings`**

In `src/routes/admin.ts`, add `getCurrentReservations` to the existing import from `../repositories/reservation-repository.js`:
```typescript
import { getReservationsByPeriod, getCurrentReservations } from '../repositories/reservation-repository.js';
```

In the `/dashboard-data` handler, after the `const bookings = reservations.map(...)` block (ends ~line 2174), add a mapper for current bookings (same shape):
```typescript
    const currentBookings = getCurrentReservations(propertyId).map(r => {
      const quote = getDocumentByReservation(r.reservation_id, 'quote');
      const invoice = getDocumentByReservation(r.reservation_id, 'invoice');
      return {
        reservationId: r.reservation_id,
        checkIn: r.check_in,
        checkOut: r.check_out,
        nights: r.nights_count,
        guestName: r.guest_name || 'Unknown Guest',
        guestsCount: r.guests_count || 0,
        status: r.status,
        confirmationCode: r.confirmation_code,
        source: r.source || r.platform || 'Unknown',
        totalPrice: r.host_payout || r.total_price || 0,
        plannedArrival: r.planned_arrival,
        plannedDeparture: r.planned_departure,
        quoteNumber: quote?.documentNumber || null,
        invoiceNumber: invoice?.documentNumber || null,
      };
    });
```
Add `currentBookings,` to the `res.json({ ... })` object (next to `stats` / `conversion` — anywhere in the top level).

- [ ] **Step 2: Add the block markup**

Replace the bookings section (lines ~843-847):
```html
    <!-- Bookings -->
    <div class="section">
      <h2 id="bookingsTitle">📅 Upcoming Bookings</h2>
      <div id="bookingsTable">Loading bookings...</div>
    </div>
```
with:
```html
    <!-- Bookings -->
    <div class="section">
      <h2>🛏️ Aktuell belegt</h2>
      <div id="currentBookingsTable" style="margin-bottom: 28px;">Loading…</div>
      <h2 id="bookingsTitle">📅 Upcoming Bookings</h2>
      <div id="bookingsTable">Loading bookings...</div>
    </div>
```

- [ ] **Step 3: Extract a shared renderer + render the block**

In the dashboard-data load function, replace the bookings-table render block (lines ~1190-1252, from `const bookingsTable = document.getElementById('bookingsTable');` through the closing `\`;` of `bookingsTable.innerHTML = \`...\``) with a shared renderer + both targets:

```javascript
        // Shared booking-rows renderer (used by the list and the "Aktuell belegt" block)
        function renderBookingsTable(list, currency) {
          if (!list || list.length === 0) return '';
          return \`
            <table>
              <thead>
                <tr>
                  <th>Confirmation</th><th>Guest Name</th><th>Check-In</th><th>Check-Out</th>
                  <th>Nights</th><th>Guests</th><th>Status</th><th>Source</th><th>Total Price</th><th>Documents</th>
                </tr>
              </thead>
              <tbody>
                \${list.map(booking => {
                  const checkIn = new Date(booking.checkIn);
                  const checkOut = new Date(booking.checkOut);
                  const statusClass = booking.status === 'confirmed' ? 'running' : 'stopped';
                  const statusText = booking.status || 'Unknown';
                  return \`
                    <tr>
                      <td style="font-family: monospace; font-size: 12px;">\${booking.confirmationCode || booking.reservationId.substring(0, 8)}</td>
                      <td>\${booking.guestName}</td>
                      <td>\${checkIn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td>\${checkOut.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td>\${booking.nights}</td>
                      <td>\${booking.guestsCount}</td>
                      <td><span class="status \${statusClass}">\${statusText}</span></td>
                      <td>\${booking.source}</td>
                      <td style="font-weight: 600;">\${currency} \${Math.round(booking.totalPrice).toLocaleString()}</td>
                      <td>
                        <button class="doc-btn quote-btn" onclick="generateDocument('\${booking.reservationId}', 'quote')" title="Angebot erstellen/laden">\${booking.quoteNumber || 'A'}</button>
                        <button class="doc-btn invoice-btn" onclick="generateDocument('\${booking.reservationId}', 'invoice')" title="Rechnung erstellen/laden">\${booking.invoiceNumber || 'R'}</button>
                        <button class="doc-btn refresh-btn" onclick="refreshDocument('\${booking.reservationId}', 'quote')" title="Angebot mit aktuellen Guesty-Daten neu generieren">↻ A</button>
                        <button class="doc-btn refresh-btn" onclick="refreshDocument('\${booking.reservationId}', 'invoice')" title="Rechnung mit aktuellen Guesty-Daten neu generieren">↻ R</button>
                      </td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
          \`;
        }

        // "Aktuell belegt" block — always visible
        const currentEl = document.getElementById('currentBookingsTable');
        currentEl.innerHTML = (data.currentBookings && data.currentBookings.length > 0)
          ? renderBookingsTable(data.currentBookings, data.listing.currency)
          : '<p style="color: #888;">Aktuell nicht belegt</p>';

        // Period bookings list
        const bookingsTable = document.getElementById('bookingsTable');
        bookingsTable.innerHTML = (data.bookings.length === 0)
          ? '<p style="color: #888;">No bookings found for this period.</p>'
          : renderBookingsTable(data.bookings, data.listing.currency);
```

(This removes the old inline `if (data.bookings.length === 0) { ... return; }` early-return and the old single `bookingsTable.innerHTML = \`<table>…\``; the catch block at the end that sets `bookingsTable.innerHTML = 'Failed to load bookings'` stays as-is.)

- [ ] **Step 4: Typecheck + lint + build**

Run: `npx tsc --noEmit` (clean), `npx eslint src/routes/admin.ts` (0 errors), `npm run build` (clean).

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(admin): always-visible 'Aktuell belegt' block with quote/invoice actions"
```

---

## Task 4: Verify

- [ ] **Step 1:** `npx vitest run` (all pass) · `npx tsc --noEmit` (clean) · `npm run build` (clean) · `npx eslint "src/**/*.ts"` (0 errors).

- [ ] **Step 2:** Manual smoke after deploy: open `/admin`, confirm the "🛏️ Aktuell belegt" block renders (a current stay if one exists, else "Aktuell nicht belegt"), that its quote/invoice buttons work, and that it stays visible when toggling Next/Last 12 Months.

---

## Self-Review Notes (author)

- **Spec coverage:** `getCurrentReservations` (Task 1); future-stats count in-house (Task 2); endpoint `currentBookings` + always-visible block with shared renderer + "Aktuell nicht belegt" empty state + doc actions (Task 3); verify (Task 4). All spec sections mapped.
- **Type consistency:** `currentBookings` mapping mirrors `bookings`; `renderBookingsTable(list, currency)` used for both targets; `getCurrentReservations` signature stable.
- **Green per commit:** Tasks 1, 2 each green; Task 3 keeps tsc/build green (frontend string + handler change land together).
- **YAGNI:** no `getReservationsByPeriod` change; no new toggle option.
