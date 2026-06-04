# Owner Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat owner/blocked days correctly across all surfaces — classify Florence's iCal blocks, make occupancy "sellable" (booked ÷ (total − blocked)), push blocked spans to the owners' Google Calendars, and show blocks distinctly in the BI email.

**Architecture:** `status='blocked'` is the canonical "non-rentable, no-revenue" marker. One foundation fix (Florence iCal classification) makes it consistent across providers; then independent consumers key on it — a sellable-occupancy breakdown in the repository, a Google-Calendar block sync (pure span/event builders + integration), and a distinct `blocked` state + block-day KPI in the BI email.

**Tech Stack:** Node.js + TypeScript (ESM, `.js` import extensions), better-sqlite3, date-fns, googleapis (calendar_v3), Vitest. Spec: `docs/superpowers/specs/2026-06-04-owner-blocks-design.md`.

**Conventions (every task):**
- ESM `.js` import extensions. Run a single test with `npx vitest run <path>` (NOT `npm test` = watch).
- Project enforces ESLint `@typescript-eslint/no-unused-vars` — run `npx eslint <changed files>` before committing and fix errors.
- Every task ends green (full `tsc` + suite pass). Order A→B→C→D; B/C/D are independent after A.

---

## File Structure

| File | Change | Package |
|---|---|---|
| `src/mappers/airbnb-mail/availability-mapper.ts` | classify iCal block vs reservation by summary | A |
| `src/repositories/availability-repository.ts` | `getOccupancyBreakdown` + DRY `getOccupancyRate` + fix `getDashboardStats` | B |
| `src/services/google-calendar-blocks.ts` (new) | pure: block spans + block events + block event id | C |
| `src/jobs/sync-google-calendar.ts` | push blocked spans + cleanup | C |
| `src/services/bi-calendar.ts` | add `'blocked'` DayState | D |
| `src/services/bi-email-templates.ts` | block color + legend + KPI block-days column | D |
| `src/types/bi-report.ts` | `PropertyKpi.blockedDays6wk` | D |
| `src/jobs/bi-email.ts` | populate `blockedDays6wk` (+ portfolio) | D |

---

## Task 1 (Pkg A): Florence iCal block classification

**Files:**
- Modify: `src/mappers/airbnb-mail/availability-mapper.ts`
- Test: `src/mappers/airbnb-mail/availability-mapper.test.ts`

- [ ] **Step 1: Add the failing tests**

Append these tests inside the existing `describe('buildAvailabilityRows', ...)` block in `src/mappers/airbnb-mail/availability-mapper.test.ts` (keep all existing tests):

```typescript
  it('classifies "Airbnb (Not available)" events as owner blocks', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-05',
      events: [
        { uid: 'BLK@airbnb.com', reservationCode: 'BLK', startDate: '2026-07-02', endDate: '2026-07-04', summary: 'Airbnb (Not available)' },
      ],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('available');           // 07-01
    expect(rows[1].status).toBe('blocked');             // 07-02
    expect(rows[1].block_type).toBe('owner');
    expect(rows[1].block_ref).toBe(null);
    expect(rows[2].status).toBe('blocked');             // 07-03
    expect(rows[3].status).toBe('available');           // 07-04 (endDate exclusive)
  });

  it('reserved events stay booked/reservation; block match is case-insensitive', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-03',
      events: [
        { uid: 'R@airbnb.com', reservationCode: 'R', startDate: '2026-07-01', endDate: '2026-07-02', summary: 'Reserved' },
        { uid: 'B@airbnb.com', reservationCode: 'B', startDate: '2026-07-02', endDate: '2026-07-03', summary: 'AIRBNB (NOT AVAILABLE)' },
      ],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('booked');
    expect(rows[0].block_type).toBe('reservation');
    expect(rows[1].status).toBe('blocked');
    expect(rows[1].block_type).toBe('owner');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mappers/airbnb-mail/availability-mapper.test.ts`
Expected: FAIL — block events are currently marked `booked`/`reservation`.

- [ ] **Step 3: Implement the classification**

Replace the body of `buildAvailabilityRows` in `src/mappers/airbnb-mail/availability-mapper.ts` so it classifies the covering event. Add a helper above it and update the per-day push:

```typescript
/** Airbnb iCal blocks (owner/host "not available") vs guest reservations. */
function isBlockEvent(summary: string): boolean {
  return /not available/i.test(summary);
}

export function buildAvailabilityRows(args: {
  listingId: string;
  windowStart: string; // YYYY-MM-DD, inclusive
  windowEnd: string;   // YYYY-MM-DD, exclusive
  events: AirbnbIcalEvent[];
  basePrice: number;
  defaultMinNights: number;
  lastSyncedAt: string;
}): Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> {
  const { listingId, windowStart, windowEnd, events, basePrice, defaultMinNights, lastSyncedAt } = args;

  const rows: Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> = [];
  let day = windowStart;
  while (day < windowEnd) {
    const event = events.find((e) => e.startDate <= day && day < e.endDate);
    const isBlock = event ? isBlockEvent(event.summary) : false;
    rows.push({
      listing_id: listingId,
      date: day,
      status: event ? (isBlock ? 'blocked' : 'booked') : 'available',
      price: basePrice,
      min_nights: defaultMinNights,
      closed_to_arrival: false,
      closed_to_departure: false,
      block_type: event ? (isBlock ? 'owner' : 'reservation') : null,
      block_ref: event && !isBlock ? event.reservationCode : null,
      last_synced_at: lastSyncedAt,
    });
    day = addDays(day, 1);
  }
  return rows;
}
```

(Keep the existing `addDays` helper and imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mappers/airbnb-mail/availability-mapper.test.ts`
Expected: PASS (all old + 2 new tests).

- [ ] **Step 5: Lint + commit**

Run: `npx eslint src/mappers/airbnb-mail/availability-mapper.ts src/mappers/airbnb-mail/availability-mapper.test.ts`

```bash
git add src/mappers/airbnb-mail/availability-mapper.ts src/mappers/airbnb-mail/availability-mapper.test.ts
git commit -m "feat(owner-blocks): classify Airbnb iCal 'Not available' as owner blocks"
```

---

## Task 2 (Pkg B): Sellable occupancy

**Files:**
- Modify: `src/repositories/availability-repository.ts`
- Test: `src/repositories/occupancy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/repositories/occupancy.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getOccupancyBreakdown, getOccupancyRate } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE availability (id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT);`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seed(statuses: string[]) {
  const ins = db.prepare(`INSERT INTO availability (listing_id,date,status) VALUES (?,?,?)`);
  statuses.forEach((s, i) => ins.run('A', `2026-06-${String(i + 1).padStart(2, '0')}`, s));
}

describe('getOccupancyBreakdown', () => {
  it('excludes blocked from the sellable base: booked / (total - blocked)', () => {
    // 10 booked, 5 blocked, 15 available -> total 30, sellable 25, rate 40%
    seed([
      ...Array(10).fill('booked'),
      ...Array(5).fill('blocked'),
      ...Array(15).fill('available'),
    ]);
    const b = getOccupancyBreakdown('A', '2026-06-01', '2026-06-31');
    expect(b.bookedDays).toBe(10);
    expect(b.blockedDays).toBe(5);
    expect(b.totalDays).toBe(30);
    expect(b.sellableDays).toBe(25);
    expect(b.rate).toBe(40);
  });

  it('all blocked -> rate 0', () => {
    seed(Array(4).fill('blocked'));
    const b = getOccupancyBreakdown('A', '2026-06-01', '2026-06-31');
    expect(b.sellableDays).toBe(0);
    expect(b.rate).toBe(0);
  });
});

describe('getOccupancyRate', () => {
  it('returns the sellable rate (delegates to breakdown)', () => {
    seed([...Array(10).fill('booked'), ...Array(5).fill('blocked'), ...Array(15).fill('available')]);
    expect(getOccupancyRate('A', '2026-06-01', '2026-06-31')).toBe(40);
  });
});
```

> NOTE: the test uses `getOccupancyRate(listingId, start, end)` with `end` exclusive (`date < end`), the existing signature. The seed dates are 2026-06-01..30, so an end of `2026-06-31` covers all.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/occupancy.test.ts`
Expected: FAIL — `getOccupancyBreakdown` not exported.

- [ ] **Step 3: Implement**

In `src/repositories/availability-repository.ts`, add `getOccupancyBreakdown` next to `getOccupancyRate`, and replace `getOccupancyRate`'s body to delegate:

```typescript
/**
 * Occupancy breakdown for [startDate, endDate). Sellable occupancy excludes
 * non-rentable (blocked) days from the base: rate = booked / (total - blocked).
 */
export function getOccupancyBreakdown(
  listingId: string,
  startDate: string,
  endDate: string
): { bookedDays: number; blockedDays: number; sellableDays: number; totalDays: number; rate: number } {
  const db = getDatabase();
  const r = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM availability
       WHERE listing_id = ? AND date >= ? AND date < ?`
    )
    .get(listingId, startDate, endDate) as { total: number; booked: number | null; blocked: number | null };
  const totalDays = r.total ?? 0;
  const bookedDays = r.booked ?? 0;
  const blockedDays = r.blocked ?? 0;
  const sellableDays = totalDays - blockedDays;
  const rate = sellableDays > 0 ? Math.round((bookedDays / sellableDays) * 100) : 0;
  return { bookedDays, blockedDays, sellableDays, totalDays, rate };
}
```

Replace the existing `getOccupancyRate` implementation with a DRY delegation (keep the same exported signature):

```typescript
/**
 * Sellable occupancy rate (%) for [startDate, endDate): booked / (total - blocked).
 */
export function getOccupancyRate(listingId: string, startDate: string, endDate: string): number {
  return getOccupancyBreakdown(listingId, startDate, endDate).rate;
}
```

Then fix `getDashboardStats` (it computes its own occupancy at the `const occupancyRate = ...` line ~426). Replace that line with sellable occupancy using the values it already has:

```typescript
    const sellableDays = availStats.total_days - availStats.blocked_days;
    const occupancyRate = sellableDays > 0 ? (availStats.booked_days / sellableDays) * 100 : 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/occupancy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite (behavior change) + lint + commit**

Run: `npx vitest run` — confirm no regression (no existing test asserted the old occupancy formula). Then `npx tsc --noEmit` and `npx eslint src/repositories/availability-repository.ts src/repositories/occupancy.test.ts`.

```bash
git add src/repositories/availability-repository.ts src/repositories/occupancy.test.ts
git commit -m "feat(owner-blocks): sellable occupancy (booked / (total - blocked)) everywhere"
```

---

## Task 3 (Pkg C): Google Calendar block builders (pure)

**Files:**
- Create: `src/services/google-calendar-blocks.ts`
- Test: `src/services/google-calendar-blocks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/google-calendar-blocks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildBlockSpans, buildBlockEvent, blockEventId } from './google-calendar-blocks.js';

describe('buildBlockSpans', () => {
  it('groups consecutive blocked days into spans (end exclusive)', () => {
    const spans = buildBlockSpans([
      { date: '2026-06-04', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-05', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-06', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-07', status: 'available', block_type: null },
      { date: '2026-06-08', status: 'blocked', block_type: null },
    ]);
    expect(spans).toEqual([
      { startDate: '2026-06-04', endExclusive: '2026-06-07', blockType: 'owner' },
      { startDate: '2026-06-08', endExclusive: '2026-06-09', blockType: null },
    ]);
  });

  it('ignores booked/available; empty input -> []', () => {
    expect(buildBlockSpans([{ date: '2026-06-04', status: 'booked', block_type: 'reservation' }])).toEqual([]);
    expect(buildBlockSpans([])).toEqual([]);
  });
});

describe('buildBlockEvent', () => {
  it('builds an all-day event with reason-based title and cleanup marker', () => {
    const ev = buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-07', blockType: 'owner' }, 'Bootshaus');
    expect(ev.summary).toBe('🔒 Owner-Block');
    expect(ev.start).toEqual({ date: '2026-06-04' });
    expect(ev.end).toEqual({ date: '2026-06-07' });
    expect(ev.location).toBe('Bootshaus');
    expect(ev.transparency).toBe('opaque');
    expect(ev.extendedProperties?.private?.kind).toBe('owner-block');
  });

  it('titles by reason where known, generic otherwise', () => {
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'maintenance' }, 'X').summary).toBe('🔒 Blockiert (Wartung)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'manual' }, 'X').summary).toBe('🔒 Blockiert (manuell)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X').summary).toBe('🔒 Blockiert');
  });
});

describe('blockEventId', () => {
  it('is stable and namespaced', () => {
    expect(blockEventId('12659677', '2026-06-04')).toBe(blockEventId('12659677', '2026-06-04'));
    expect(blockEventId('12659677', '2026-06-04')).not.toBe(blockEventId('12659677', '2026-06-05'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/google-calendar-blocks.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/services/google-calendar-blocks.ts`**

```typescript
/**
 * Pure builders for syncing blocked (non-rentable) availability spans to a
 * shared Google Calendar. No I/O — the sync job does the API calls.
 */
import type { calendar_v3 } from 'googleapis';
import { toGoogleEventId } from './google-event-id.js';

export interface BlockSpan {
  startDate: string;     // YYYY-MM-DD, inclusive
  endExclusive: string;  // YYYY-MM-DD, exclusive (Google all-day end)
  blockType: string | null;
}

function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().split('T')[0];
}

/** Group consecutive `status==='blocked'` days into spans (end exclusive). */
export function buildBlockSpans(
  days: Array<{ date: string; status: string; block_type: string | null }>
): BlockSpan[] {
  const blocked = days
    .filter((d) => d.status === 'blocked')
    .sort((a, b) => a.date.localeCompare(b.date));
  const spans: BlockSpan[] = [];
  for (const day of blocked) {
    const last = spans[spans.length - 1];
    if (last && last.endExclusive === day.date) {
      last.endExclusive = addOneDay(day.date); // extend contiguous span
    } else {
      spans.push({ startDate: day.date, endExclusive: addOneDay(day.date), blockType: day.block_type });
    }
  }
  return spans;
}

const BLOCK_TITLES: Record<string, string> = {
  owner: '🔒 Owner-Block',
  maintenance: '🔒 Blockiert (Wartung)',
  manual: '🔒 Blockiert (manuell)',
};

/** Stable, base32hex-safe event id, namespaced to avoid reservation-id collisions. */
export function blockEventId(listingId: string, startDate: string): string {
  return toGoogleEventId(`blk-${listingId}-${startDate}`);
}

/** Build an all-day Google Calendar event for a blocked span. */
export function buildBlockEvent(span: BlockSpan, propertyName: string): calendar_v3.Schema$Event {
  return {
    summary: (span.blockType && BLOCK_TITLES[span.blockType]) || '🔒 Blockiert',
    location: propertyName,
    start: { date: span.startDate },
    end: { date: span.endExclusive },
    transparency: 'opaque',
    extendedProperties: { private: { kind: 'owner-block' } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/google-calendar-blocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npx tsc --noEmit` and `npx eslint src/services/google-calendar-blocks.ts src/services/google-calendar-blocks.test.ts`.

```bash
git add src/services/google-calendar-blocks.ts src/services/google-calendar-blocks.test.ts
git commit -m "feat(owner-blocks): pure Google Calendar block span/event builders"
```

---

## Task 4 (Pkg C): Wire block sync into the Google Calendar job

**Files:**
- Modify: `src/jobs/sync-google-calendar.ts`

No new unit test (integration glue over the Google API; builders are covered by Task 3). Mirrors the existing reservation sync.

- [ ] **Step 1: Add imports**

At the top of `src/jobs/sync-google-calendar.ts`, after the existing imports add:

```typescript
import { getAvailability } from '../repositories/availability-repository.js';
import { buildBlockSpans, buildBlockEvent, blockEventId } from '../services/google-calendar-blocks.js';
```

- [ ] **Step 2: Extend the result counters**

In `GoogleCalendarSyncResult`, add two optional counters (after `eventsDeleted`):

```typescript
  blockEventsUpserted?: number;
  blockEventsDeleted?: number;
```

- [ ] **Step 3: Add the block-sync block inside `syncGoogleCalendarForProperty`**

Inside the `try` of `syncGoogleCalendarForProperty`, AFTER the reservation upsert/delete loops and BEFORE `const durationMs = Date.now() - startTime;`, insert:

```typescript
    // ----- Owner/blocked-day spans -> shared calendar -----
    const today = new Date().toISOString().split('T')[0];
    const horizonEnd = new Date();
    horizonEnd.setDate(horizonEnd.getDate() + 365);
    const horizonEndStr = horizonEnd.toISOString().split('T')[0];

    const availability = getAvailability(listingId, today, horizonEndStr);
    const spans = buildBlockSpans(
      availability.map((a) => ({ date: a.date, status: a.status, block_type: a.block_type }))
    );
    const desiredBlockIds = new Set(spans.map((s) => blockEventId(listingId, s.startDate)));

    let blockEventsUpserted = 0;
    for (const span of spans) {
      try {
        await googleCalendarClient.upsertEvent(calendarId, blockEventId(listingId, span.startDate), buildBlockEvent(span, name));
        blockEventsUpserted++;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : error, span, propertySlug: slug },
          'Failed to upsert block calendar event'
        );
      }
    }

    // Cleanup: delete our block events (marked kind='owner-block') that no longer apply.
    let blockEventsDeleted = 0;
    try {
      const existing = await googleCalendarClient.listEvents(calendarId, `${today}T00:00:00Z`, `${horizonEndStr}T00:00:00Z`);
      for (const ev of existing) {
        if (ev.extendedProperties?.private?.kind !== 'owner-block') continue;
        if (ev.id && !desiredBlockIds.has(ev.id)) {
          const deleted = await googleCalendarClient.deleteEvent(calendarId, ev.id);
          if (deleted) blockEventsDeleted++;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : error, propertySlug: slug }, 'Block cleanup listEvents failed');
    }
```

- [ ] **Step 4: Include the counters in the success log + return**

Update the success `logger.info({...})` call to add `blockEventsUpserted, blockEventsDeleted,` and change the success `return` to:

```typescript
    return { success: true, eventsUpserted, eventsDeleted, blockEventsUpserted, blockEventsDeleted, durationMs };
```

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npx tsc --noEmit` and `npx eslint src/jobs/sync-google-calendar.ts`. Then run `npx vitest run` (no behavior tested here, but confirm nothing broke).

```bash
git add src/jobs/sync-google-calendar.ts
git commit -m "feat(owner-blocks): push blocked spans to shared Google Calendars with cleanup"
```

---

## Task 5 (Pkg D): Distinct `blocked` state in the BI calendar

**Files:**
- Modify: `src/services/bi-calendar.ts`
- Modify: `src/services/bi-calendar.test.ts`
- Modify: `src/services/bi-email-templates.ts` (COLORS + legend — coupled to the DayState change)
- Modify: `src/services/bi-email-templates.test.ts`

- [ ] **Step 1: Update the calendar test**

In `src/services/bi-calendar.test.ts`, the existing "marks booked, free and turnover correctly" test asserts `days[2]` (a `blocked` availability) is `'booked'`. Change that assertion and add a comment:

```typescript
    expect(days[2]).toBe('blocked');  // 06-04 availability status 'blocked' -> own state
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/bi-calendar.test.ts`
Expected: FAIL — current code maps blocked → 'booked'.

- [ ] **Step 3: Add the `blocked` DayState in `src/services/bi-calendar.ts`**

Change the `DayState` type and the day classification in `buildGanttGrid`:

```typescript
export type DayState = 'booked' | 'free' | 'turnover' | 'blocked';
```

In the per-day loop, replace the final push line:

```typescript
      const status = statusByDate.get(d);
      if (status === 'booked') days.push('booked');
      else if (status === 'blocked') days.push('blocked');
      else days.push('free');
```

(Turnover detection above this stays unchanged and still takes precedence.)

- [ ] **Step 4: Update the template COLORS + legend (keeps tsc green)**

In `src/services/bi-email-templates.ts`, `COLORS` is typed `Record<DayState, string>` — adding `'blocked'` to the union requires a color. Update it:

```typescript
const COLORS: Record<DayState, string> = {
  booked: '#e07a5f',
  free: '#e8eae6',
  turnover: '#3d5a80',
  blocked: '#b9bfb6',
};
```

In `renderCalendar`, add a legend swatch for blocked — change the legend paragraph to include it after "frei":

```typescript
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.blocked};vertical-align:middle;margin-left:12px"></span> blockiert
```

(Insert that span between the "frei" and "Turnover" legend entries.)

- [ ] **Step 5: Add a template assertion**

In `src/services/bi-email-templates.test.ts`, the model's calendar `rows[0].days` currently is `['booked','free','turnover','booked','free','free','booked']`. Change one cell to `'blocked'` and assert the color renders. Replace that days array with:

```typescript
    rows: [{ slug: 'farmhouse', name: 'Farmhouse', days: ['booked', 'free', 'turnover', 'blocked', 'free', 'free', 'booked'] }],
```

And add to the existing "returns html and text" test:

```typescript
    expect(html).toContain('#b9bfb6');     // blocked color rendered in the gantt
    expect(html.toLowerCase()).toContain('blockiert'); // legend entry
```

- [ ] **Step 6: Run the affected tests + full green**

Run: `npx vitest run src/services/bi-calendar.test.ts src/services/bi-email-templates.test.ts` → PASS.
Then `npx tsc --noEmit` (clean) and `npx eslint src/services/bi-calendar.ts src/services/bi-email-templates.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/services/bi-calendar.ts src/services/bi-calendar.test.ts src/services/bi-email-templates.ts src/services/bi-email-templates.test.ts
git commit -m "feat(owner-blocks): distinct 'blocked' state + colour in BI calendar"
```

---

## Task 6 (Pkg D): Block-day count in the KPI table

**Files:**
- Modify: `src/types/bi-report.ts`
- Modify: `src/jobs/bi-email.ts`
- Modify: `src/jobs/bi-email.test.ts`
- Modify: `src/services/bi-email-templates.ts`
- Modify: `src/services/bi-email-templates.test.ts`

- [ ] **Step 1: Add the test assertions**

In `src/jobs/bi-email.test.ts`, the availability-repository mock must provide `getOccupancyBreakdown`. Add it to that `vi.mock` factory (next to `getOccupancyRate`):

```typescript
  getOccupancyBreakdown: vi.fn(() => ({ bookedDays: 20, blockedDays: 3, sellableDays: 27, totalDays: 30, rate: 70 })),
```

Add to the first test (`assembles portfolio totals...`):

```typescript
    expect(model.kpis[0]).toHaveProperty('blockedDays6wk', 3);
    expect(model.portfolio).toHaveProperty('blockedDays6wk');
```

In `src/services/bi-email-templates.test.ts`, add `blockedDays6wk` to the model's kpi entry and a `blockedDays6wk` to the portfolio block:

```typescript
  // in kpis[0]: add
  blockedDays6wk: 3,
  // in portfolio: add
  blockedDays6wk: 5,
```

And assert the KPI table renders a block-days column header:

```typescript
    expect(html).toContain('Block-Tg');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/bi-email.test.ts src/services/bi-email-templates.test.ts`
Expected: FAIL — `blockedDays6wk` missing.

- [ ] **Step 3: Extend the types**

In `src/types/bi-report.ts`, add to `PropertyKpi` (after `adr`):

```typescript
  blockedDays6wk: number; // owner/blocked days in the next 6 weeks
```

And to `BiReportModel.portfolio` (after `committedRevenueHorizon`):

```typescript
    blockedDays6wk: number;
```

- [ ] **Step 4: Populate in `src/jobs/bi-email.ts`**

Add `getOccupancyBreakdown` to the availability-repository import. Where the KPI is built (the `occ6wk`/`occ30d` block), compute block days for the 6-week window and add to the `kpi` object:

```typescript
      const occ6wk = getOccupancyRate(listingId, today, in6Weeks);
      const occ30d = getOccupancyRate(listingId, last30, today);
      const blockedDays6wk = getOccupancyBreakdown(listingId, today, in6Weeks).blockedDays;
```

Add `blockedDays6wk,` to the `kpi: { ... }` object literal (after `adr`). Then in the returned `portfolio` object add the portfolio sum (next to `committedRevenueHorizon`):

```typescript
      blockedDays6wk: collected.reduce((s, c) => s + c.kpi.blockedDays6wk, 0),
```

- [ ] **Step 5: Render the column in `src/services/bi-email-templates.ts`**

In `renderKpiTable`, add an `ADR`-adjacent column. Add a header cell `${th('Block-Tg')}` at the end of the header row, a body cell `${td(String(k.blockedDays6wk))}` at the end of each body row, and a total cell. Concretely, update the three pieces:

Header row — append after `${th('ADR')}`:

```typescript
${th('Block-Tg')}
```

Body row — append after `${td(eur(k.adr))}`:

```typescript
${td(String(k.blockedDays6wk))}
```

Total row — append one more cell after the existing trailing `${td('')}`:

```typescript
${td(String(portfolio.blockedDays6wk))}
```

- [ ] **Step 6: Run tests + full green**

Run: `npx vitest run src/jobs/bi-email.test.ts src/services/bi-email-templates.test.ts` → PASS.
Then `npx tsc --noEmit` (clean) and `npx eslint src/types/bi-report.ts src/jobs/bi-email.ts src/services/bi-email-templates.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/types/bi-report.ts src/jobs/bi-email.ts src/jobs/bi-email.test.ts src/services/bi-email-templates.ts src/services/bi-email-templates.test.ts
git commit -m "feat(owner-blocks): show owner-block days in the BI KPI table"
```

---

## Task 7: Full verification + live render

**Files:** none (verification only)

- [ ] **Step 1: Whole suite + build + lint**

Run: `npx vitest run` (all pass) · `npx tsc --noEmit` (clean) · `npm run build` (clean) · `npx eslint "src/**/*.ts"` (0 errors; pre-existing `any` warnings OK).

- [ ] **Step 2: Render the BI email against the live DB**

Create `bi-preview-tmp.ts` in repo root:

```typescript
import { initDatabase } from './src/db/index.js';
import { getAllProperties, getBiReportConfig } from './src/config/properties.js';
import { buildBiReportModel } from './src/jobs/bi-email.js';
import { generateBiReportEmail } from './src/services/bi-email-templates.js';
import { writeFileSync } from 'node:fs';
initDatabase();
const cfg = getBiReportConfig();
const model = buildBiReportModel(getAllProperties(), new Date(), cfg?.forecastHorizonMonths ?? 6);
writeFileSync('/tmp/bi-report-preview.html', generateBiReportEmail(model).html);
const o = (s: string) => process.stderr.write('CHK ' + s + '\n');
o('kpis: ' + model.kpis.map((k) => `${k.name} occ6wk=${k.occupancy6wk}% block=${k.blockedDays6wk}`).join(' | '));
o('portfolio blockedDays6wk=' + model.portfolio.blockedDays6wk);
o('gantt blocked cells: ' + model.calendar.rows.map((r) => `${r.name}:${r.days.filter((d) => d === 'blocked').length}`).join(' '));
```

Run: `npx tsx bi-preview-tmp.ts 2>&1 | grep '^CHK'` then `rm -f bi-preview-tmp.ts`
Expected: Bootshaus shows `blocked` cells (4–7 Jun) in the gantt and a non-zero `blockedDays6wk`; occupancy reflects the sellable formula.

- [ ] **Step 3: Final commit (if any tweaks)**

```bash
git add -A && git commit -m "chore(owner-blocks): verification pass" || echo "nothing to commit"
```

---

## Self-Review Notes (author)

- **Spec coverage:** Pkg A Florence classification (Task 1); Pkg B sellable occupancy in `getOccupancyRate` + `getOccupancyBreakdown` + `getDashboardStats` (Task 2); Pkg C pure builders (Task 3) + GCal integration with `extendedProperties` cleanup (Task 4); Pkg D distinct `blocked` state/colour (Task 5) + block-day KPI (Task 6); verification + live render (Task 7). All spec sections mapped.
- **Green per commit:** every task ends green (no red sequencing). Task 5 bundles the DayState change with the template COLORS/legend because the `Record<DayState,…>` makes them tsc-coupled.
- **Type consistency:** `getOccupancyBreakdown` shape (`bookedDays/blockedDays/sellableDays/totalDays/rate`) used identically in Tasks 2 & 6; `BlockSpan`/`blockEventId`/`buildBlockEvent` consistent across Tasks 3 & 4; `blockedDays6wk` consistent across Tasks 6 type/job/template. `DayState` 'blocked' added once (Task 5) and consumed in COLORS.
- **YAGNI:** no back-sync, no block management UI, no Hostex reason inference (status-keyed).
- **Decision baked:** GCal pushes all `status='blocked'` spans; titles by `block_type` with generic fallback; Florence owner blocks (block_type 'owner') render as "🔒 Owner-Block".
