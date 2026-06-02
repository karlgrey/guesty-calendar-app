# Portfolio-BI-Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly portfolio-wide BI email summarizing all properties: a 6-week occupancy Gantt, the next 5 arrivals/turnovers, a per-property KPI table, and a 6-month "on-the-books + pickup" forecast.

**Architecture:** Pure computation modules (`forecast.ts`, `bi-calendar.ts`) consume plain data and are fully unit-tested; thin repository helpers add the few queries we lack; an orchestration job (`bi-email.ts`) gathers data across all properties via existing repos, builds a `BiReportModel`, and renders it through `bi-email-templates.ts`. A new top-level `biReport` config block in `data/properties.json` drives an hourly, timezone-aware scheduler check.

**Tech Stack:** Node.js + TypeScript (ESM, `.js` import extensions), better-sqlite3 (sync), date-fns + date-fns-tz, Zod, Resend (via existing `sendEmail`), Vitest.

**Conventions for every task:**
- ESM imports MUST use `.js` extensions (e.g. `import { x } from './forecast.js'`).
- Run a single test file with `npx vitest run <path>` (plain `npm test` is watch mode).
- Money fields use `host_payout` with `COALESCE(host_payout, total_price, 0)`, matching existing reports.
- Only `status IN ('confirmed','reserved')` counts as a real booking (matches `getReservationsByPeriod`).
- Commit after each task with the shown message.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/properties.ts` (modify) | Add `biReport` top-level schema + `getBiReportConfig()` |
| `src/repositories/reservation-repository.ts` (modify) | Add `getLeadTimeSamples()`, `getRevenueForCheckInMonth()` |
| `src/repositories/availability-repository.ts` (modify) | Add `getOccupancyCounts()` |
| `src/services/forecast.ts` (create) | Pure: lead-time curve + OTB/pickup month forecast |
| `src/services/bi-calendar.ts` (create) | Pure: availability+reservations → Gantt grid w/ turnovers |
| `src/types/bi-report.ts` (create) | Shared `BiReportModel` and sub-types |
| `src/services/bi-email-templates.ts` (create) | `generateBiReportEmail(model)` → `{html,text}` |
| `src/jobs/bi-email.ts` (create) | Orchestration: `sendBiReportEmail()`, `shouldSendBiReport()` |
| `src/jobs/scheduler.ts` (modify) | Hourly biReport check + state |
| `src/scripts/test-bi-email.ts` (create) | Manual one-shot send |
| `data/properties.json` (modify) | Add `biReport` config block |
| `CLAUDE.md` (modify) | Document the BI email |

---

## Task 1: `biReport` config block + loader

**Files:**
- Modify: `src/config/properties.ts`
- Test: `src/config/properties.bi-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/config/properties.bi-report.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseBiReportConfig, type BiReportConfig } from './properties.js';

describe('parseBiReportConfig', () => {
  it('parses a full valid block', () => {
    const cfg = parseBiReportConfig({
      enabled: true,
      recipients: ['owner@example.com'],
      day: 1,
      hour: 6,
      timezone: 'Europe/Berlin',
      forecastHorizonMonths: 6,
    });
    expect(cfg).toEqual({
      enabled: true,
      recipients: ['owner@example.com'],
      day: 1,
      hour: 6,
      timezone: 'Europe/Berlin',
      forecastHorizonMonths: 6,
    });
  });

  it('applies defaults for timezone and horizon', () => {
    const cfg = parseBiReportConfig({ enabled: true, recipients: ['o@e.com'], day: 1, hour: 6 });
    expect(cfg.timezone).toBe('Europe/Berlin');
    expect(cfg.forecastHorizonMonths).toBe(6);
  });

  it('returns undefined when block is absent', () => {
    expect(parseBiReportConfig(undefined)).toBeUndefined();
  });

  it('throws on invalid email', () => {
    expect(() => parseBiReportConfig({ enabled: true, recipients: ['nope'], day: 1, hour: 6 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/properties.bi-report.test.ts`
Expected: FAIL — `parseBiReportConfig` is not exported.

- [ ] **Step 3: Implement**

In `src/config/properties.ts`, after the `WeeklyReportConfig` interface (around line 46) add:

```typescript
/**
 * Portfolio BI report configuration (top-level, not per-property).
 */
export interface BiReportConfig {
  enabled: boolean;
  recipients: string[];
  day: number;   // 0 = Sunday, 1 = Monday, ...
  hour: number;  // 0-23
  timezone: string;
  forecastHorizonMonths: number;
}
```

After `weeklyReportConfigSchema` (around line 130) add:

```typescript
const biReportConfigSchema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().email()),
  day: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  timezone: z.string().default('Europe/Berlin'),
  forecastHorizonMonths: z.number().int().min(1).max(12).default(6),
});

/**
 * Validate a raw biReport block. Returns undefined when the block is absent.
 * Exported for unit testing.
 */
export function parseBiReportConfig(raw: unknown): BiReportConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  return biReportConfigSchema.parse(raw);
}
```

Change `propertiesFileSchema` (around line 200) to allow the new optional key:

```typescript
const propertiesFileSchema = z.object({
  properties: z.array(propertyConfigSchema).min(1, 'At least one property is required'),
  biReport: biReportConfigSchema.optional(),
});
```

Add a cache var next to `cachedProperties` (around line 207):

```typescript
let cachedBiReport: BiReportConfig | null | undefined = undefined; // undefined = not loaded yet
```

In `loadPropertiesConfig()`, right after `cachedProperties = validatedConfig.properties;` (around line 249) add:

```typescript
    cachedBiReport = validatedConfig.biReport ?? null;
```

Add a getter after `getDefaultProperty()` (around line 350):

```typescript
/**
 * Get the portfolio BI report config, or undefined if not configured.
 */
export function getBiReportConfig(): BiReportConfig | undefined {
  loadPropertiesConfig();
  return cachedBiReport ?? undefined;
}
```

In `clearPropertiesCache()` (around line 371) also reset the new cache:

```typescript
export function clearPropertiesCache(): void {
  cachedProperties = null;
  cachedBiReport = undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/properties.bi-report.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/properties.ts src/config/properties.bi-report.test.ts
git commit -m "feat(bi-email): add biReport config schema + getBiReportConfig"
```

---

## Task 2: Repository helpers

**Files:**
- Modify: `src/repositories/reservation-repository.ts`
- Modify: `src/repositories/availability-repository.ts`
- Test: `src/repositories/bi-report-queries.test.ts`

These three functions are the only new SQL we need.

- [ ] **Step 1: Write the failing test**

Create `src/repositories/bi-report-queries.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getLeadTimeSamples, getRevenueForCheckInMonth } from './reservation-repository.js';
import { getOccupancyCounts } from './availability-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT,
      check_in TEXT, check_out TEXT, nights_count INTEGER,
      status TEXT, host_payout REAL, total_price REAL, reserved_at TEXT
    );
    CREATE TABLE availability (
      id INTEGER PRIMARY KEY, listing_id TEXT, date TEXT, status TEXT
    );
  `);
  setDatabase(db);
});

afterEach(() => {
  resetDatabase();
  db.close();
});

describe('getLeadTimeSamples', () => {
  it('returns checkIn/reservedAt across all listings, skips null reserved_at', () => {
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r1', 'A', '2026-07-10', '2026-07-15', 'confirmed', '2026-06-01T00:00:00Z');
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r2', 'B', '2026-08-01', '2026-08-05', 'reserved', '2026-07-20T00:00:00Z');
    db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,reserved_at) VALUES (?,?,?,?,?,?)`)
      .run('r3', 'A', '2026-09-01', '2026-09-03', 'confirmed', null);
    const samples = getLeadTimeSamples();
    expect(samples).toHaveLength(2);
    expect(samples).toContainEqual({ checkIn: '2026-07-10', reservedAt: '2026-06-01T00:00:00Z' });
  });
});

describe('getRevenueForCheckInMonth', () => {
  it('sums host_payout for confirmed/reserved with check_in in the given month', () => {
    const ins = db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,host_payout,total_price) VALUES (?,?,?,?,?,?,?)`);
    ins.run('r1', 'A', '2026-06-10', '2026-06-12', 'confirmed', 500, 600);
    ins.run('r2', 'A', '2026-06-20', '2026-06-22', 'reserved', null, 300); // falls back to total_price
    ins.run('r3', 'A', '2026-07-01', '2026-07-03', 'confirmed', 999, 999); // other month
    ins.run('r4', 'A', '2026-06-25', '2026-06-27', 'canceled', 999, 999);  // excluded status
    expect(getRevenueForCheckInMonth('A', '2026-06')).toBe(800);
  });
});

describe('getOccupancyCounts', () => {
  it('counts booked/blocked days vs total in [start,end)', () => {
    const ins = db.prepare(`INSERT INTO availability (listing_id,date,status) VALUES (?,?,?)`);
    ins.run('A', '2026-06-01', 'booked');
    ins.run('A', '2026-06-02', 'blocked');
    ins.run('A', '2026-06-03', 'available');
    ins.run('A', '2026-06-04', 'available');
    const c = getOccupancyCounts('A', '2026-06-01', '2026-06-05');
    expect(c).toEqual({ occupiedDays: 2, totalDays: 4 });
  });
});
```

> NOTE: This test assumes `src/db/index.js` exposes `setDatabase(db)` and `resetDatabase()` test helpers and that repos call `getDatabase()`. **Step 2a below verifies this**; if they don't exist, add them in Step 2a before proceeding.

- [ ] **Step 2a: Verify/add DB test seam**

Run: `grep -n "export function setDatabase\|export function resetDatabase\|export function getDatabase" src/db/index.ts`

If `setDatabase`/`resetDatabase` are missing, add to `src/db/index.ts`:

```typescript
/** Test seam: inject an in-memory DB. */
export function setDatabase(testDb: import('better-sqlite3').Database): void {
  db = testDb;
}
/** Test seam: clear the injected DB handle. */
export function resetDatabase(): void {
  db = null;
}
```

(Match the existing module-level `db` variable name in that file; if the cached handle has a different name, assign to that instead.)

- [ ] **Step 2b: Run test to verify it fails**

Run: `npx vitest run src/repositories/bi-report-queries.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement the three functions**

In `src/repositories/reservation-repository.ts` add near the other read functions:

```typescript
/**
 * Lead-time samples for the pickup forecast, pooled across ALL listings.
 * Only rows with a real booking date and a future-relative check_in count.
 */
export function getLeadTimeSamples(): Array<{ checkIn: string; reservedAt: string }> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT date(check_in) AS checkIn, reserved_at AS reservedAt
       FROM reservations
       WHERE reserved_at IS NOT NULL
         AND status IN ('confirmed','reserved')
         AND date(check_in) > date(reserved_at)`
    )
    .all() as Array<{ checkIn: string; reservedAt: string }>;
  return rows;
}

/**
 * Net revenue (host_payout) for reservations whose check_in falls in the given
 * YYYY-MM month. Used for the KPI monthly column and the OTB revenue forecast.
 */
export function getRevenueForCheckInMonth(listingId: string, yyyymm: string): number {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT SUM(COALESCE(host_payout, total_price, 0)) AS revenue
       FROM reservations
       WHERE listing_id = ?
         AND status IN ('confirmed','reserved')
         AND strftime('%Y-%m', date(check_in)) = ?`
    )
    .get(listingId, yyyymm) as { revenue: number | null };
  return row.revenue ?? 0;
}
```

In `src/repositories/availability-repository.ts` add next to `getOccupancyRate`:

```typescript
/**
 * Raw occupancy counts for [startDate, endDate) — occupied (booked/blocked) and total.
 * getOccupancyRate rounds to a percentage; this keeps the night counts the
 * forecast needs.
 */
export function getOccupancyCounts(
  listingId: string,
  startDate: string,
  endDate: string
): { occupiedDays: number; totalDays: number } {
  const db = getDatabase();
  const result = db
    .prepare(
      `SELECT
         COUNT(*) AS total_days,
         SUM(CASE WHEN status IN ('booked','blocked') THEN 1 ELSE 0 END) AS occupied_days
       FROM availability
       WHERE listing_id = ? AND date >= ? AND date < ?`
    )
    .get(listingId, startDate, endDate) as { total_days: number; occupied_days: number | null };
  return { occupiedDays: result.occupied_days ?? 0, totalDays: result.total_days ?? 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/bi-report-queries.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repositories/reservation-repository.ts src/repositories/availability-repository.ts src/repositories/bi-report-queries.test.ts src/db/index.ts
git commit -m "feat(bi-email): add lead-time, monthly-revenue, occupancy-count queries"
```

---

## Task 3: Forecast module (pure)

**Files:**
- Create: `src/services/forecast.ts`
- Test: `src/services/forecast.test.ts`

Math (deterministic, no `Date` inside the module):
- `leadDays = floor((checkIn − reservedAt) / 1 day)`, kept `>= 0`.
- `shareOnBooksAt(d)` = fraction of samples with `leadDays >= d`, floored at `0.05` (a booking `d` days out is "already on the books now" iff its lead ≥ d). At `d=0` → `1.0`.
- `committedPct = otbNights / capacityNights * 100`.
- `projectedFinalPct = min(100, committedPct / share)`.
- `bandPct = round((1 − share) * 35) + (lowData ? 8 : 0)`, capped at 40.
- `committedRevenue = otbRevenue`; `projectedRevenue = round(otbRevenue / share)`.
- `lowData = propertySampleN < 15 || curve.n < 20`.

- [ ] **Step 1: Write the failing test**

Create `src/services/forecast.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildLeadTimeCurve, shareOnBooksAt, forecastMonth } from './forecast.js';

describe('buildLeadTimeCurve', () => {
  it('computes lead days (>=0) and sample count', () => {
    const curve = buildLeadTimeCurve([
      { checkIn: '2026-07-11', reservedAt: '2026-07-01' }, // 10
      { checkIn: '2026-07-01', reservedAt: '2026-07-01' }, // 0
      { checkIn: '2026-06-01', reservedAt: '2026-07-01' }, // negative -> clamped to 0
    ]);
    expect(curve.n).toBe(3);
    expect(curve.leadDays).toEqual([10, 0, 0]);
  });
});

describe('shareOnBooksAt', () => {
  const curve = buildLeadTimeCurve([
    { checkIn: '2026-02-01', reservedAt: '2026-01-02' }, // 30
    { checkIn: '2026-02-01', reservedAt: '2026-01-12' }, // 20
    { checkIn: '2026-02-01', reservedAt: '2026-01-22' }, // 10
    { checkIn: '2026-02-01', reservedAt: '2026-02-01' }, // 0
  ]);
  it('is 1.0 at d=0', () => expect(shareOnBooksAt(curve, 0)).toBeCloseTo(1.0));
  it('counts leadDays >= d', () => {
    // d=15 -> leads 30,20 qualify -> 2/4 = 0.5
    expect(shareOnBooksAt(curve, 15)).toBeCloseTo(0.5);
  });
  it('floors at 0.05 for far horizons', () => {
    expect(shareOnBooksAt(curve, 999)).toBeCloseTo(0.05);
  });
});

describe('forecastMonth', () => {
  const curve = buildLeadTimeCurve(
    Array.from({ length: 40 }, (_, i) => ({
      checkIn: '2026-03-01',
      reservedAt: `2026-0${i % 2 === 0 ? '1' : '2'}-01`, // mix of ~59 and ~28 day leads
    }))
  );
  it('near month: high share -> projected ~= committed, small band', () => {
    const f = forecastMonth({
      monthLabel: 'Jun', otbNights: 20, capacityNights: 30,
      otbRevenue: 4000, daysUntilMidpoint: 0, curve, propertySampleN: 40,
    });
    expect(f.committedPct).toBe(67);
    expect(f.projectedFinalPct).toBe(67);
    expect(f.bandPct).toBe(0);
    expect(f.projectedRevenue).toBe(4000);
    expect(f.lowData).toBe(false);
  });
  it('far month: low share -> projected > committed, wide band, capped at 100', () => {
    const f = forecastMonth({
      monthLabel: 'Nov', otbNights: 6, capacityNights: 30,
      otbRevenue: 1200, daysUntilMidpoint: 999, curve, propertySampleN: 40,
    });
    expect(f.committedPct).toBe(20);
    expect(f.projectedFinalPct).toBe(100); // 20 / 0.05 = 400 -> capped
    expect(f.bandPct).toBeGreaterThan(20);
    expect(f.projectedRevenue).toBe(24000); // 1200 / 0.05
  });
  it('flags low data when property sample is small', () => {
    const f = forecastMonth({
      monthLabel: 'Aug', otbNights: 10, capacityNights: 30,
      otbRevenue: 2000, daysUntilMidpoint: 30, curve, propertySampleN: 5,
    });
    expect(f.lowData).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/forecast.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/services/forecast.ts`**

```typescript
/**
 * Forecast (pure functions) — "on the books" + pickup projection.
 *
 * No Date usage: callers pass `daysUntilMidpoint` for each month so the math
 * stays deterministic and unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHARE_FLOOR = 0.05;

export interface LeadTimeCurve {
  leadDays: number[];
  n: number;
}

export interface MonthForecast {
  monthLabel: string;
  committedPct: number;
  projectedFinalPct: number;
  bandPct: number;
  committedRevenue: number;
  projectedRevenue: number;
  lowData: boolean;
}

/** Build a pooled lead-time curve from booking samples. */
export function buildLeadTimeCurve(
  samples: Array<{ checkIn: string; reservedAt: string }>
): LeadTimeCurve {
  const leadDays = samples.map((s) => {
    const diff = (new Date(s.checkIn).getTime() - new Date(s.reservedAt).getTime()) / MS_PER_DAY;
    return Math.max(0, Math.floor(diff));
  });
  return { leadDays, n: leadDays.length };
}

/** Fraction of final bookings already on the books `d` days before check-in. */
export function shareOnBooksAt(curve: LeadTimeCurve, daysBefore: number): number {
  if (curve.n === 0) return 1; // no history -> assume fully booked (committed only)
  const qualifying = curve.leadDays.filter((l) => l >= daysBefore).length;
  return Math.max(SHARE_FLOOR, qualifying / curve.n);
}

export interface ForecastMonthInput {
  monthLabel: string;
  otbNights: number;
  capacityNights: number;
  otbRevenue: number;
  daysUntilMidpoint: number;
  curve: LeadTimeCurve;
  propertySampleN: number;
}

/** Project a single month's final occupancy + revenue from OTB and the curve. */
export function forecastMonth(input: ForecastMonthInput): MonthForecast {
  const { monthLabel, otbNights, capacityNights, otbRevenue, daysUntilMidpoint, curve, propertySampleN } = input;
  const share = shareOnBooksAt(curve, Math.max(0, daysUntilMidpoint));
  const committedPct = capacityNights > 0 ? Math.round((otbNights / capacityNights) * 100) : 0;
  const projectedFinalPct = Math.min(100, Math.round(committedPct / share));
  const lowData = propertySampleN < 15 || curve.n < 20;
  const bandPct = Math.min(40, Math.round((1 - share) * 35) + (lowData ? 8 : 0));
  return {
    monthLabel,
    committedPct,
    projectedFinalPct,
    bandPct,
    committedRevenue: Math.round(otbRevenue),
    projectedRevenue: Math.round(otbRevenue / share),
    lowData,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/forecast.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/forecast.ts src/services/forecast.test.ts
git commit -m "feat(bi-email): pure forecast module (lead-time curve + pickup projection)"
```

---

## Task 4: Calendar grid builder (pure)

**Files:**
- Create: `src/services/bi-calendar.ts`
- Test: `src/services/bi-calendar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/bi-calendar.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildGanttGrid } from './bi-calendar.js';

describe('buildGanttGrid', () => {
  const base = {
    startDate: '2026-06-02',
    dayCount: 14,
    properties: [
      {
        slug: 'farmhouse',
        name: 'Farmhouse',
        availability: [
          { date: '2026-06-02', status: 'booked' },
          { date: '2026-06-03', status: 'available' },
          { date: '2026-06-04', status: 'blocked' },
        ],
        // checkout 06-02 AND checkin 06-02 -> turnover on 06-02
        reservations: [
          { check_in: '2026-05-30', check_out: '2026-06-02' },
          { check_in: '2026-06-02', check_out: '2026-06-05' },
        ],
      },
    ],
  };

  it('produces one row per property with dayCount days', () => {
    const grid = buildGanttGrid(base);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].days).toHaveLength(14);
  });

  it('marks booked, free and turnover correctly', () => {
    const grid = buildGanttGrid(base);
    const days = grid.rows[0].days;
    expect(days[0]).toBe('turnover'); // 06-02 checkout+checkin, overrides booked
    expect(days[1]).toBe('free');     // 06-03 available
    expect(days[2]).toBe('booked');   // 06-04 blocked
  });

  it('emits a date label every 7 days', () => {
    const grid = buildGanttGrid(base);
    expect(grid.labels.map((l) => l.index)).toEqual([0, 7]);
    expect(grid.labels[0].label).toBe('2 Jun');
    expect(grid.labels[1].label).toBe('9 Jun');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/bi-calendar.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/services/bi-calendar.ts`**

```typescript
/**
 * BI calendar (pure functions) — builds a per-property Gantt grid of
 * booked / free / turnover day states plus date labels every 7 days.
 */
import { addDays, format } from 'date-fns';

export type DayState = 'booked' | 'free' | 'turnover';

export interface PropertyGanttRow {
  slug: string;
  name: string;
  days: DayState[];
}

export interface DateLabel {
  index: number;
  label: string;
}

export interface GanttGrid {
  startDate: string;
  dayCount: number;
  rows: PropertyGanttRow[];
  labels: DateLabel[];
}

export interface GanttInput {
  startDate: string; // YYYY-MM-DD
  dayCount: number;  // e.g. 42
  properties: Array<{
    slug: string;
    name: string;
    availability: Array<{ date: string; status: string }>;
    reservations: Array<{ check_in: string; check_out: string }>;
  }>;
}

const day = (iso: string) => iso.slice(0, 10);

export function buildGanttGrid(input: GanttInput): GanttGrid {
  const start = new Date(`${input.startDate}T00:00:00Z`);

  const rows: PropertyGanttRow[] = input.properties.map((p) => {
    const statusByDate = new Map(p.availability.map((a) => [day(a.date), a.status]));
    const checkIns = new Set(p.reservations.map((r) => day(r.check_in)));
    const checkOuts = new Set(p.reservations.map((r) => day(r.check_out)));

    const days: DayState[] = [];
    for (let i = 0; i < input.dayCount; i++) {
      const d = format(addDays(start, i), 'yyyy-MM-dd');
      const isTurnover = checkIns.has(d) && checkOuts.has(d);
      if (isTurnover) {
        days.push('turnover');
        continue;
      }
      const status = statusByDate.get(d);
      days.push(status === 'booked' || status === 'blocked' ? 'booked' : 'free');
    }
    return { slug: p.slug, name: p.name, days };
  });

  const labels: DateLabel[] = [];
  for (let i = 0; i < input.dayCount; i += 7) {
    labels.push({ index: i, label: format(addDays(start, i), 'd MMM') });
  }

  return { startDate: input.startDate, dayCount: input.dayCount, rows, labels };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/bi-calendar.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/bi-calendar.ts src/services/bi-calendar.test.ts
git commit -m "feat(bi-email): pure Gantt grid builder with turnover detection"
```

---

## Task 5: Shared model types

**Files:**
- Create: `src/types/bi-report.ts`

No test (type-only file). It is validated by `tsc` when later tasks import it.

- [ ] **Step 1: Create `src/types/bi-report.ts`**

```typescript
/**
 * Shared data model for the portfolio BI email. Built by `bi-email.ts`,
 * rendered by `bi-email-templates.ts`.
 */
import type { GanttGrid } from '../services/bi-calendar.js';
import type { MonthForecast } from '../services/forecast.js';

export interface PropertyKpi {
  slug: string;
  name: string;
  occupancy6wk: number;      // %
  occupancy30d: number;      // %
  revenueYtd: number;
  revenueMonth: number;
  revenueChangePct: number;  // vs previous month
  bookingsYtd: number;
  adr: number;               // avg daily rate (YTD revenue / booked nights)
  currency: string;
}

export interface UpcomingArrival {
  date: string;        // YYYY-MM-DD (check_in)
  propertySlug: string;
  propertyName: string;
  guestName: string;
  nights: number;
  guests: number;
  source: string;
  isTurnover: boolean; // same-day checkout+checkin at this property
}

export interface PropertyForecast {
  slug: string;
  name: string;
  lowData: boolean;
  months: MonthForecast[];
}

export interface BiReportModel {
  generatedAt: string;   // ISO timestamp
  weekLabel: string;     // e.g. "2. Jun 2026"
  currency: string;
  portfolio: {
    revenueYtd: number;
    avgOccupancy6wk: number;
    bookingsYtd: number;
    committedRevenueHorizon: number; // committed € over forecast horizon
  };
  calendar: GanttGrid;
  arrivals: UpcomingArrival[];
  kpis: PropertyKpi[];
  portfolioForecast: MonthForecast[];
  propertyForecasts: PropertyForecast[];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors introduced by the new file).

- [ ] **Step 3: Commit**

```bash
git add src/types/bi-report.ts
git commit -m "feat(bi-email): shared BiReportModel types"
```

---

## Task 6: Email template renderer

**Files:**
- Create: `src/services/bi-email-templates.ts`
- Test: `src/services/bi-email-templates.test.ts`

Email-safe HTML: table layout, inline styles, no external CSS/JS. Colors: booked `#e07a5f`, free `#e8eae6`, turnover `#3d5a80`.

- [ ] **Step 1: Write the failing test**

Create `src/services/bi-email-templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateBiReportEmail } from './bi-email-templates.js';
import type { BiReportModel } from '../types/bi-report.js';

const model: BiReportModel = {
  generatedAt: '2026-06-02T06:00:00Z',
  weekLabel: '2. Jun 2026',
  currency: 'EUR',
  portfolio: { revenueYtd: 123400, avgOccupancy6wk: 68, bookingsYtd: 181, committedRevenueHorizon: 87200 },
  calendar: {
    startDate: '2026-06-02', dayCount: 7,
    rows: [{ slug: 'farmhouse', name: 'Farmhouse', days: ['booked', 'free', 'turnover', 'booked', 'free', 'free', 'booked'] }],
    labels: [{ index: 0, label: '2 Jun' }],
  },
  arrivals: [
    { date: '2026-06-03', propertySlug: 'u19', propertyName: 'Uferstrasse 19', guestName: 'Max M.', nights: 4, guests: 2, source: 'direct', isTurnover: false },
  ],
  kpis: [
    { slug: 'farmhouse', name: 'Farmhouse', occupancy6wk: 74, occupancy30d: 68, revenueYtd: 32400, revenueMonth: 4850, revenueChangePct: 12, bookingsYtd: 41, adr: 168, currency: 'EUR' },
  ],
  portfolioForecast: [
    { monthLabel: 'Jun', committedPct: 68, projectedFinalPct: 78, bandPct: 4, committedRevenue: 18000, projectedRevenue: 20600, lowData: false },
  ],
  propertyForecasts: [
    { slug: 'farmhouse', name: 'Farmhouse', lowData: false, months: [
      { monthLabel: 'Jun', committedPct: 70, projectedFinalPct: 80, bandPct: 4, committedRevenue: 4000, projectedRevenue: 4600, lowData: false },
    ] },
  ],
};

describe('generateBiReportEmail', () => {
  it('returns html and text', () => {
    const { html, text } = generateBiReportEmail(model);
    expect(html).toContain('<html');
    expect(html).toContain('Farmhouse');
    expect(html).toContain('Uferstrasse 19');
    expect(html).toContain('123');           // portfolio YTD revenue rendered
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Farmhouse');
  });

  it('renders a low-data marker when a property forecast is flagged', () => {
    const flagged: BiReportModel = {
      ...model,
      propertyForecasts: [{ ...model.propertyForecasts[0], lowData: true }],
    };
    const { html } = generateBiReportEmail(flagged);
    expect(html.toLowerCase()).toContain('dünne datenbasis');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/bi-email-templates.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/services/bi-email-templates.ts`**

```typescript
/**
 * Portfolio BI email renderer. Email-safe HTML (tables + inline styles only).
 */
import type { BiReportModel, PropertyKpi, UpcomingArrival } from '../types/bi-report.js';
import type { DayState, GanttGrid } from './bi-calendar.js';
import type { MonthForecast } from './forecast.js';

const COLORS: Record<DayState, string> = {
  booked: '#e07a5f',
  free: '#e8eae6',
  turnover: '#3d5a80',
};

function eur(n: number): string {
  return `${Math.round(n).toLocaleString('de-DE')} €`;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function deltaCell(changePct: number): string {
  const color = changePct >= 0 ? '#3d8b5f' : '#c0573f';
  const sign = changePct >= 0 ? '+' : '−';
  return `<span style="color:${color}">${sign}${Math.abs(changePct)}%</span>`;
}

function renderCalendar(cal: GanttGrid): string {
  const labelCells = cal.labels
    .map((l) => `<td colspan="7" style="font:600 10px sans-serif;color:#888;padding:2px 0">${l.label}</td>`)
    .join('');
  const rows = cal.rows
    .map((row) => {
      const cells = row.days
        .map((d) => `<td style="width:13px;height:18px;border:1px solid #fff;background:${COLORS[d]}"></td>`)
        .join('');
      return `<tr><td style="font:600 11px sans-serif;padding:3px 8px 3px 0;white-space:nowrap">${row.name}</td>${cells}</tr>`;
    })
    .join('');
  return `
    <table style="border-collapse:collapse">
      <tr><td></td>${labelCells}</tr>
      ${rows}
    </table>
    <p style="font:11px sans-serif;color:#555;margin:8px 0 0">
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.booked};vertical-align:middle"></span> belegt
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.free};vertical-align:middle;margin-left:12px"></span> frei
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.turnover};vertical-align:middle;margin-left:12px"></span> Turnover
    </p>`;
}

function renderArrivals(arrivals: UpcomingArrival[]): string {
  if (arrivals.length === 0) return '<p style="font:13px sans-serif;color:#888">Keine anstehenden Anreisen.</p>';
  const rows = arrivals
    .map((a) => {
      const turn = a.isTurnover
        ? ' <span style="background:#3d5a80;color:#fff;font:600 9px sans-serif;padding:1px 5px;border-radius:8px">Turnover</span>'
        : '';
      return `<tr>
        <td style="padding:5px 10px;font:600 12px sans-serif;border-bottom:1px solid #eee">${a.date}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${a.propertyName}${turn}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${a.guestName}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee;text-align:right">${a.nights} N · ${a.guests} P</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${a.source}</td>
      </tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`;
}

function renderKpiTable(kpis: PropertyKpi[], portfolio: BiReportModel['portfolio']): string {
  const th = (t: string) =>
    `<th style="font:600 11px sans-serif;color:#888;padding:6px 8px;border-bottom:2px solid #ddd;text-align:right">${t}</th>`;
  const td = (t: string, align = 'right') =>
    `<td style="font:12px sans-serif;padding:6px 8px;border-bottom:1px solid #eee;text-align:${align}">${t}</td>`;
  const body = kpis
    .map(
      (k) => `<tr>
        ${td(k.name, 'left')}${td(pct(k.occupancy6wk))}${td(pct(k.occupancy30d))}
        ${td(eur(k.revenueYtd))}${td(eur(k.revenueMonth))}${td(deltaCell(k.revenueChangePct))}
        ${td(String(k.bookingsYtd))}${td(eur(k.adr))}
      </tr>`
    )
    .join('');
  const total = `<tr style="background:#f7f8f6;font-weight:700">
      ${td('Portfolio', 'left')}${td(pct(portfolio.avgOccupancy6wk))}${td('')}
      ${td(eur(portfolio.revenueYtd))}${td('')}${td('')}${td(String(portfolio.bookingsYtd))}${td('')}
    </tr>`;
  return `<table style="border-collapse:collapse;width:100%">
      <tr><th style="text-align:left;font:600 11px sans-serif;color:#888;padding:6px 8px;border-bottom:2px solid #ddd">Property</th>
        ${th('Bel. 6Wo')}${th('Bel. 30Tg')}${th('Umsatz YTD')}${th('Umsatz Monat')}${th('Δ Vormon.')}${th('Buch. YTD')}${th('ADR')}</tr>
      ${body}${total}
    </table>`;
}

function renderForecastBars(months: MonthForecast[]): string {
  const bars = months
    .map((m) => {
      const committedH = Math.round(m.committedPct * 1.4);
      const pickupH = Math.round(Math.max(0, m.projectedFinalPct - m.committedPct) * 1.4);
      return `<td style="vertical-align:bottom;text-align:center;padding:0 4px">
        <div style="font:9px sans-serif;color:#666">${pct(m.projectedFinalPct)}</div>
        <div style="display:inline-block;width:40px;background:#e8eae6">
          <div style="height:${pickupH}px;background:#f2c4b6"></div>
          <div style="height:${committedH}px;background:#e07a5f"></div>
        </div>
        <div style="font:600 11px sans-serif;margin-top:4px">${m.monthLabel}</div>
        <div style="font:9px sans-serif;color:#999">±${m.bandPct}%</div>
      </td>`;
    })
    .join('');
  return `<table style="border-collapse:collapse"><tr>${bars}</tr></table>`;
}

function renderPropertyForecasts(forecasts: BiReportModel['propertyForecasts']): string {
  return forecasts
    .map((f) => {
      const flag = f.lowData
        ? ' <span style="font:600 9px sans-serif;color:#b4543a">(dünne Datenbasis)</span>'
        : '';
      return `<div style="margin-top:14px">
        <div style="font:600 12px sans-serif;margin-bottom:4px">${f.name}${flag}</div>
        ${renderForecastBars(f.months)}
      </div>`;
    })
    .join('');
}

export function generateBiReportEmail(model: BiReportModel): { html: string; text: string } {
  const stat = (value: string, label: string) =>
    `<td style="background:#f7f8f6;padding:12px;text-align:center">
      <div style="font:700 16px sans-serif">${value}</div>
      <div style="font:10px sans-serif;color:#888">${label}</div>
    </td>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;background:#fff">
    <div style="max-width:680px;margin:0 auto;border:1px solid #e2e4df;border-radius:10px;overflow:hidden">
      <div style="background:#2f3a33;color:#fff;padding:16px 18px">
        <div style="font:700 16px sans-serif">📊 Portfolio-Report · ${model.weekLabel}</div>
        <div style="font:11px sans-serif;opacity:.7;margin-top:2px">${model.kpis.length} Properties</div>
      </div>
      <table style="border-collapse:separate;border-spacing:1px;width:100%"><tr>
        ${stat(eur(model.portfolio.revenueYtd), 'Umsatz YTD')}
        ${stat(pct(model.portfolio.avgOccupancy6wk), 'Ø Belegung 6 Wo')}
        ${stat(String(model.portfolio.bookingsYtd), 'Buchungen YTD')}
        ${stat(eur(model.portfolio.committedRevenueHorizon), 'fest gebucht')}
      </tr></table>
      <div style="padding:16px 18px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">① Übersichtskalender · 6 Wochen</h3>
        ${renderCalendar(model.calendar)}
      </div>
      <div style="padding:0 18px 16px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">② Nächste Anreisen &amp; Turnovers</h3>
        ${renderArrivals(model.arrivals)}
      </div>
      <div style="padding:0 18px 16px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">③ Kennzahlen pro Property</h3>
        ${renderKpiTable(model.kpis, model.portfolio)}
      </div>
      <div style="padding:0 18px 18px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">④ Forecast · 6 Monate</h3>
        <div style="font:11px sans-serif;color:#888;margin-bottom:6px">Portfolio (fest gebucht + Pickup-Hochrechnung):</div>
        ${renderForecastBars(model.portfolioForecast)}
        ${renderPropertyForecasts(model.propertyForecasts)}
      </div>
      <div style="background:#f7f8f6;padding:10px 18px;font:10px sans-serif;color:#999;text-align:center">
        Remote Republic · automatischer Portfolio-Report
      </div>
    </div>
    </body></html>`;

  const textLines = [
    `Portfolio-Report · ${model.weekLabel}`,
    `Umsatz YTD: ${eur(model.portfolio.revenueYtd)} · Ø Belegung 6Wo: ${pct(model.portfolio.avgOccupancy6wk)} · Buchungen YTD: ${model.portfolio.bookingsYtd} · fest gebucht: ${eur(model.portfolio.committedRevenueHorizon)}`,
    '',
    'Kennzahlen:',
    ...model.kpis.map(
      (k) => `  ${k.name}: Bel ${pct(k.occupancy6wk)}/${pct(k.occupancy30d)}, Umsatz YTD ${eur(k.revenueYtd)} (Monat ${eur(k.revenueMonth)}, ${k.revenueChangePct >= 0 ? '+' : ''}${k.revenueChangePct}%), Buchungen ${k.bookingsYtd}, ADR ${eur(k.adr)}`
    ),
    '',
    'Nächste Anreisen:',
    ...model.arrivals.map(
      (a) => `  ${a.date} ${a.propertyName} — ${a.guestName} (${a.nights}N/${a.guests}P, ${a.source})${a.isTurnover ? ' [Turnover]' : ''}`
    ),
    '',
    'Forecast (Portfolio):',
    ...model.portfolioForecast.map(
      (m) => `  ${m.monthLabel}: ${pct(m.committedPct)} fest → ${pct(m.projectedFinalPct)} erwartet (±${m.bandPct}%)`
    ),
  ];

  return { html, text: textLines.join('\n') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/bi-email-templates.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/bi-email-templates.ts src/services/bi-email-templates.test.ts
git commit -m "feat(bi-email): email-safe HTML+text renderer"
```

---

## Task 7: Orchestration job

**Files:**
- Create: `src/jobs/bi-email.ts`
- Test: `src/jobs/bi-email.test.ts`

This job composes everything. The data-gathering helper `buildBiReportModel(properties, now)` is exported and tested with mocked repositories; `sendBiReportEmail()` and `shouldSendBiReport()` wrap it.

- [ ] **Step 1: Write the failing test**

Create `src/jobs/bi-email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn(() => ({ title: 'T', nickname: null, currency: 'EUR' })),
}));
vi.mock('../repositories/availability-repository.js', () => ({
  getAllTimeStats: vi.fn(() => ({ totalBookings: 40, totalRevenue: 30000, totalBookedDays: 200, startDate: '2025-07-01', endDate: '2026-06-02' })),
  getCurrentYearStats: vi.fn(() => ({ year: 2026, totalBookings: 20, totalRevenue: 15000, totalBookedDays: 100 })),
  getOccupancyRate: vi.fn(() => 70),
  getOccupancyCounts: vi.fn(() => ({ occupiedDays: 20, totalDays: 30 })),
  getAvailability: vi.fn(() => []),
}));
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationsByPeriod: vi.fn(() => [
    { reservation_id: 'r1', check_in: '2026-06-03', check_out: '2026-06-07', nights_count: 4, guest_name: 'Max M.', guests_count: 2, source: 'direct', platform: null, host_payout: 800, total_price: 800, status: 'confirmed' },
  ]),
  getReservationsInRange: vi.fn(() => []),
  getLeadTimeSamples: vi.fn(() => Array.from({ length: 30 }, () => ({ checkIn: '2026-07-01', reservedAt: '2026-06-01' }))),
  getRevenueForCheckInMonth: vi.fn(() => 4000),
}));

import { buildBiReportModel } from './bi-email.js';
import type { PropertyConfig } from '../config/properties.js';

const prop = (slug: string, name: string): PropertyConfig => ({
  slug, name, provider: 'guesty', guestyPropertyId: `id-${slug}`,
  timezone: 'Europe/Berlin', currency: 'EUR',
  bookingRecipientEmail: 'b@e.com', bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
});

describe('buildBiReportModel', () => {
  it('assembles portfolio totals, calendar, arrivals, kpis and forecasts', () => {
    const model = buildBiReportModel(
      [prop('farmhouse', 'Farmhouse'), prop('u19', 'Uferstrasse 19')],
      new Date('2026-06-02T06:00:00Z'),
      6
    );
    expect(model.kpis).toHaveLength(2);
    expect(model.calendar.rows).toHaveLength(2);
    expect(model.calendar.dayCount).toBe(42);
    expect(model.portfolio.bookingsYtd).toBe(40); // 20 + 20 current-year bookings
    expect(model.arrivals.length).toBeGreaterThan(0);
    expect(model.arrivals[0].guestName).toBe('Max M.');
    expect(model.portfolioForecast).toHaveLength(6);
    expect(model.propertyForecasts).toHaveLength(2);
  });

  it('isolates a failing property without throwing', () => {
    const ok = prop('farmhouse', 'Farmhouse');
    const broken = { ...prop('bad', 'Bad'), guestyPropertyId: undefined, provider: 'guesty' as const };
    const model = buildBiReportModel([ok, broken], new Date('2026-06-02T06:00:00Z'), 6);
    // broken property has no listing id -> skipped, but model still builds
    expect(model.kpis.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/jobs/bi-email.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/jobs/bi-email.ts`**

```typescript
/**
 * Portfolio BI Email Job
 *
 * Gathers data across ALL properties, builds a BiReportModel and sends one
 * consolidated weekly email. Complements the per-property weekly reports.
 */
import { addDays, addMonths, format, getDay, getHours, startOfMonth, endOfMonth, differenceInCalendarDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  getAllProperties,
  getBiReportConfig,
  getListingId,
  type PropertyConfig,
} from '../config/properties.js';
import { getListingById } from '../repositories/listings-repository.js';
import {
  getAllTimeStats,
  getCurrentYearStats,
  getOccupancyRate,
  getOccupancyCounts,
  getAvailability,
} from '../repositories/availability-repository.js';
import {
  getReservationsByPeriod,
  getLeadTimeSamples,
  getRevenueForCheckInMonth,
} from '../repositories/reservation-repository.js';
import { buildGanttGrid } from '../services/bi-calendar.js';
import { buildLeadTimeCurve, forecastMonth, type MonthForecast } from '../services/forecast.js';
import { generateBiReportEmail } from '../services/bi-email-templates.js';
import { sendEmail } from '../services/email-service.js';
import type { BiReportModel, PropertyKpi, UpcomingArrival, PropertyForecast } from '../types/bi-report.js';
import logger from '../utils/logger.js';

const CALENDAR_DAYS = 42;
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

interface PropertyData {
  property: PropertyConfig;
  listingId: string;
  futureReservations: ReturnType<typeof getReservationsByPeriod>;
  sampleN: number;
  kpi: PropertyKpi;
}

/** Build the full report model. Pure-ish: all I/O is via injected repos. */
export function buildBiReportModel(
  properties: PropertyConfig[],
  now: Date,
  horizonMonths: number
): BiReportModel {
  const today = ymd(now);
  const in6Weeks = ymd(addDays(now, CALENDAR_DAYS));
  const last30 = ymd(addDays(now, -30));
  const curMonth = format(now, 'yyyy-MM');
  const prevMonth = format(addMonths(now, -1), 'yyyy-MM');

  // Pooled lead-time curve across the whole portfolio
  const curve = buildLeadTimeCurve(getLeadTimeSamples());

  const collected: PropertyData[] = [];

  for (const property of properties) {
    try {
      const listingId = getListingId(property);
      const listing = getListingById(listingId);
      if (!listing) {
        logger.warn({ propertySlug: property.slug }, 'BI report: listing not found, skipping');
        continue;
      }

      const allTime = getAllTimeStats(listingId);
      const currentYear = getCurrentYearStats(listingId);
      const occ6wk = getOccupancyRate(listingId, today, in6Weeks);
      const occ30d = getOccupancyRate(listingId, last30, today);
      const revMonth = getRevenueForCheckInMonth(listingId, curMonth);
      const revPrev = getRevenueForCheckInMonth(listingId, prevMonth);
      const changePct = revPrev > 0 ? Math.round(((revMonth - revPrev) / revPrev) * 100) : revMonth > 0 ? 100 : 0;
      const adr = currentYear.totalBookedDays > 0 ? currentYear.totalRevenue / currentYear.totalBookedDays : 0;

      const futureReservations = getReservationsByPeriod(listingId, 365, 'future');

      collected.push({
        property,
        listingId,
        futureReservations,
        sampleN: allTime.totalBookings,
        kpi: {
          slug: property.slug,
          name: property.name,
          occupancy6wk: occ6wk,
          occupancy30d: occ30d,
          revenueYtd: currentYear.totalRevenue,
          revenueMonth: revMonth,
          revenueChangePct: changePct,
          bookingsYtd: currentYear.totalBookings,
          adr,
          currency: listing.currency || property.currency || 'EUR',
        },
      });
    } catch (error) {
      logger.error({ error, propertySlug: property.slug }, 'BI report: failed to gather property data, skipping');
    }
  }

  // Calendar grid
  const calendar = buildGanttGrid({
    startDate: today,
    dayCount: CALENDAR_DAYS,
    properties: collected.map((c) => ({
      slug: c.property.slug,
      name: c.property.name,
      availability: getAvailabilitySafe(c.listingId, today, in6Weeks),
      reservations: c.futureReservations.map((r) => ({ check_in: r.check_in, check_out: r.check_out })),
    })),
  });

  // Next 5 arrivals portfolio-wide
  const arrivals: UpcomingArrival[] = collected
    .flatMap((c) => {
      const checkOuts = new Set(c.futureReservations.map((r) => r.check_out.slice(0, 10)));
      return c.futureReservations.map((r) => ({
        date: r.check_in.slice(0, 10),
        propertySlug: c.property.slug,
        propertyName: c.property.name,
        guestName: r.guest_name || 'Unbekannt',
        nights: r.nights_count || 0,
        guests: r.guests_count || 0,
        source: r.source || r.platform || 'Unbekannt',
        isTurnover: checkOuts.has(r.check_in.slice(0, 10)),
      }));
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  // Forecast per month (portfolio + per property)
  const months = Array.from({ length: horizonMonths }, (_, i) => addMonths(now, i));

  const portfolioForecast = months.map((m) =>
    forecastMonthAcross(collected.map((c) => c.listingId), m, now, curve, sumSampleN(collected))
  );

  const propertyForecasts: PropertyForecast[] = collected.map((c) => ({
    slug: c.property.slug,
    name: c.property.name,
    lowData: c.sampleN < 15 || curve.n < 20,
    months: months.map((m) => forecastMonthForListing(c.listingId, m, now, curve, c.sampleN)),
  }));

  const committedRevenueHorizon = portfolioForecast.reduce((s, m) => s + m.committedRevenue, 0);
  const avgOccupancy6wk = collected.length
    ? Math.round(collected.reduce((s, c) => s + c.kpi.occupancy6wk, 0) / collected.length)
    : 0;

  return {
    generatedAt: now.toISOString(),
    weekLabel: format(now, 'd. MMM yyyy'),
    currency: collected[0]?.kpi.currency || 'EUR',
    portfolio: {
      revenueYtd: collected.reduce((s, c) => s + c.kpi.revenueYtd, 0),
      avgOccupancy6wk,
      bookingsYtd: collected.reduce((s, c) => s + c.kpi.bookingsYtd, 0),
      committedRevenueHorizon,
    },
    calendar,
    arrivals,
    kpis: collected.map((c) => c.kpi),
    portfolioForecast,
    propertyForecasts,
  };
}

function sumSampleN(collected: PropertyData[]): number {
  return collected.reduce((s, c) => s + c.sampleN, 0);
}

function getAvailabilitySafe(listingId: string, start: string, end: string) {
  // getAvailability returns full Availability rows; the grid only needs date+status.
  return getAvailability(listingId, start, end).map((a) => ({ date: a.date, status: a.status }));
}

function monthOccAndRevenue(listingId: string, monthDate: Date) {
  const start = ymd(startOfMonth(monthDate));
  const endExclusive = ymd(addDays(endOfMonth(monthDate), 1));
  const counts = getOccupancyCounts(listingId, start, endExclusive);
  const revenue = getRevenueForCheckInMonth(listingId, format(monthDate, 'yyyy-MM'));
  return { counts, revenue };
}

function daysUntilMidpoint(monthDate: Date, now: Date): number {
  const mid = addDays(startOfMonth(monthDate), 14);
  return Math.max(0, differenceInCalendarDays(mid, now));
}

function forecastMonthForListing(
  listingId: string,
  monthDate: Date,
  now: Date,
  curve: ReturnType<typeof buildLeadTimeCurve>,
  sampleN: number
): MonthForecast {
  const { counts, revenue } = monthOccAndRevenue(listingId, monthDate);
  return forecastMonth({
    monthLabel: format(monthDate, 'MMM'),
    otbNights: counts.occupiedDays,
    capacityNights: counts.totalDays,
    otbRevenue: revenue,
    daysUntilMidpoint: daysUntilMidpoint(monthDate, now),
    curve,
    propertySampleN: sampleN,
  });
}

function forecastMonthAcross(
  listingIds: string[],
  monthDate: Date,
  now: Date,
  curve: ReturnType<typeof buildLeadTimeCurve>,
  sampleN: number
): MonthForecast {
  let otbNights = 0;
  let capacityNights = 0;
  let otbRevenue = 0;
  for (const id of listingIds) {
    const { counts, revenue } = monthOccAndRevenue(id, monthDate);
    otbNights += counts.occupiedDays;
    capacityNights += counts.totalDays;
    otbRevenue += revenue;
  }
  return forecastMonth({
    monthLabel: format(monthDate, 'MMM'),
    otbNights,
    capacityNights,
    otbRevenue,
    daysUntilMidpoint: daysUntilMidpoint(monthDate, now),
    curve,
    propertySampleN: sampleN,
  });
}

/** Send the consolidated BI report email. */
export async function sendBiReportEmail(): Promise<{ success: boolean; sent: boolean; error?: string }> {
  const biConfig = getBiReportConfig();
  if (!biConfig || !biConfig.enabled) {
    logger.debug('BI report disabled or not configured');
    return { success: true, sent: false };
  }
  if (!biConfig.recipients.length) {
    logger.warn('BI report enabled but no recipients configured');
    return { success: true, sent: false, error: 'No recipients' };
  }

  try {
    const properties = getAllProperties();
    const model = buildBiReportModel(properties, new Date(), biConfig.forecastHorizonMonths);
    const { html, text } = generateBiReportEmail(model);

    const sent = await sendEmail({
      to: biConfig.recipients,
      subject: `📊 Portfolio-Report · ${model.weekLabel}`,
      html,
      text,
    });

    if (sent) {
      logger.info({ recipients: biConfig.recipients.length, properties: model.kpis.length }, '✅ BI report email sent');
      return { success: true, sent: true };
    }
    return { success: false, sent: false, error: 'Email sending failed' };
  } catch (error) {
    logger.error({ error }, '❌ BI report email job failed');
    return { success: false, sent: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/** True when the configured day+hour matches now in the report timezone. */
export function shouldSendBiReport(): boolean {
  const biConfig = getBiReportConfig();
  if (!biConfig || !biConfig.enabled) return false;
  const zoned = toZonedTime(new Date(), biConfig.timezone);
  return getDay(zoned) === biConfig.day && getHours(zoned) === biConfig.hour;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/jobs/bi-email.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/bi-email.ts src/jobs/bi-email.test.ts
git commit -m "feat(bi-email): orchestration job (buildBiReportModel, sendBiReportEmail, shouldSendBiReport)"
```

---

## Task 8: Scheduler wiring

**Files:**
- Modify: `src/jobs/scheduler.ts`

No new test (scheduler is integration glue; behavior is covered by `bi-email.test.ts` + manual script). Mirror the existing weekly-email wiring.

- [ ] **Step 1: Add import**

At the top of `src/jobs/scheduler.ts`, after the weekly-email import (line 8):

```typescript
import { sendBiReportEmail, shouldSendBiReport } from './bi-email.js';
import { getBiReportConfig } from '../config/properties.js';
```

(Extend the existing `../config/properties.js` import instead of duplicating if simpler.)

- [ ] **Step 2: Add scheduler state**

In `SchedulerState` (after `propertyGoogleCalendarLastSync` at line 38) add:

```typescript
  biReportIntervalId: NodeJS.Timeout | null;
  biReportSent: Date | null;
```

In the `state` initializer (after `propertyGoogleCalendarLastSync: new Map(),` line 60) add:

```typescript
  biReportIntervalId: null,
  biReportSent: null,
```

- [ ] **Step 3: Add the check function**

After `checkAndSendWeeklyEmail()` (around line 214) add:

```typescript
/**
 * Check and send the portfolio BI report once per scheduled slot.
 */
async function checkAndSendBiReport() {
  try {
    if (!shouldSendBiReport()) return;

    const today = new Date().toDateString();
    if (state.biReportSent?.toDateString() === today) {
      logger.debug('BI report already sent today, skipping');
      return;
    }

    logger.info('📊 BI report conditions met, sending...');
    const result = await sendBiReportEmail();
    if (result.sent) {
      state.biReportSent = new Date();
    }
  } catch (error) {
    logger.error({ error }, 'Error in BI report check');
  }
}
```

- [ ] **Step 4: Start the checker in `startScheduler()`**

After the weekly-email scheduler block (after line 429, before the daily forced sync block) add:

```typescript
  // Start portfolio BI report checker (runs every hour)
  const biConfig = getBiReportConfig();
  if (biConfig?.enabled) {
    logger.info(
      { day: biConfig.day, hour: biConfig.hour, recipients: biConfig.recipients.length, timezone: biConfig.timezone },
      '📊 Starting portfolio BI report scheduler'
    );
    checkAndSendBiReport();
    state.biReportIntervalId = setInterval(checkAndSendBiReport, 60 * 60 * 1000);
  }
```

- [ ] **Step 5: Clear the interval in `stopScheduler()`**

After the `googleCalendarIntervalId` clear block (around line 511) add:

```typescript
  if (state.biReportIntervalId) {
    clearInterval(state.biReportIntervalId);
    state.biReportIntervalId = null;
  }
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/scheduler.ts
git commit -m "feat(bi-email): wire portfolio BI report into the scheduler"
```

---

## Task 9: Manual test script

**Files:**
- Create: `src/scripts/test-bi-email.ts`

- [ ] **Step 1: Create the script**

```typescript
/**
 * Manual one-shot send of the portfolio BI report.
 * Respects DEV_EMAIL_OVERRIDE (outside production all mail is redirected).
 *
 * Usage: npx tsx src/scripts/test-bi-email.ts
 */
import { sendBiReportEmail } from '../jobs/bi-email.js';
import logger from '../utils/logger.js';

async function main() {
  logger.info('📊 Sending test portfolio BI report...');
  const result = await sendBiReportEmail();
  if (result.sent) {
    logger.info('✅ BI report sent');
  } else {
    logger.warn({ error: result.error }, '⚠️  BI report not sent (check biReport config / recipients)');
  }
  process.exit(result.sent ? 0 : 1);
}

main().catch((error) => {
  logger.error({ error }, '❌ test-bi-email failed');
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-run (requires a synced local DB + biReport block from Task 10)**

Run: `npx tsx src/scripts/test-bi-email.ts`
Expected: With `DEV_EMAIL_OVERRIDE` set and a populated DB, logs `✅ BI report sent`. Without recipients/config, logs the warning and exits 1. Either is acceptable here — the goal is no crash/stacktrace.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/test-bi-email.ts
git commit -m "feat(bi-email): manual test-bi-email script"
```

---

## Task 10: Config block + documentation

**Files:**
- Modify: `data/properties.json`
- Modify: `CLAUDE.md`

> ⚠️ Production note (from project memory): prod's `data/properties.json` has uncommitted recipient edits — a deploy must `git stash` / `git stash pop` around `git pull`, a plain pull aborts. Adding a new top-level `biReport` key is additive and safe, but flag it in the deploy.

- [ ] **Step 1: Add the `biReport` block to `data/properties.json`**

Add a top-level sibling to `"properties"` (use the real owner address):

```json
  "biReport": {
    "enabled": true,
    "recipients": ["mic@dynamicdudes.com"],
    "day": 1,
    "hour": 6,
    "timezone": "Europe/Berlin",
    "forecastHorizonMonths": 6
  }
```

- [ ] **Step 2: Verify config loads**

Run: `npx tsx -e "import('./src/config/properties.js').then(m => console.log(m.getBiReportConfig()))"`
Expected: prints the parsed object with `enabled: true`, `forecastHorizonMonths: 6`. No Zod error.

- [ ] **Step 3: Document in `CLAUDE.md`**

Under the "Weekly Email Reports" section, add a subsection:

```markdown
### Portfolio BI Report (alle Properties)

Eine wöchentliche, konsolidierte Mail über alle Properties — ergänzt die per-Property-Weekly-Reports.
Konfiguration als **Top-Level-Block** `biReport` in `data/properties.json`:
`{ enabled, recipients[], day (0-6), hour (0-23), timezone, forecastHorizonMonths }`.

- Scheduler prüft stündlich (timezone-aware), sendet einmal pro Slot (`shouldSendBiReport()`).
- Inhalt: Portfolio-Summenband · 6-Wochen-Belegungskalender (belegt/frei/Turnover) · nächste 5
  Anreisen & Turnovers · KPI-Tabelle pro Property · 6-Monats-Forecast (OTB + gepoolter Pickup).
- Forecast: `src/services/forecast.ts` (Lead-Time-Kurve aus `reserved_at`), Kalender:
  `src/services/bi-calendar.ts`, Orchestrierung: `src/jobs/bi-email.ts`.
- Manueller Test: `npx tsx src/scripts/test-bi-email.ts` (respektiert `DEV_EMAIL_OVERRIDE`).
- Spec: `docs/superpowers/specs/2026-06-02-portfolio-bi-email-design.md`
```

- [ ] **Step 4: Commit**

```bash
git add data/properties.json CLAUDE.md
git commit -m "feat(bi-email): enable biReport config + document portfolio BI report"
```

---

## Task 11: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS, including the new `forecast`, `bi-calendar`, `bi-email-templates`, `bi-email`, `bi-report-queries`, and `properties.bi-report` tests.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors in the added files.

- [ ] **Step 4: End-to-end smoke (local)**

Run: `npm run sync:force` (populate DB) then `DEV_EMAIL_OVERRIDE=mic@dynamicdudes.com npx tsx src/scripts/test-bi-email.ts`
Expected: `✅ BI report sent` (redirected to the override address). Open the received mail and sanity-check the 5 sections render.

- [ ] **Step 5: Final commit (if any docs/tweaks remain)**

```bash
git add -A
git commit -m "chore(bi-email): verification pass" || echo "nothing to commit"
```

---

## Self-Review Notes (author)

- **Spec coverage:** Summenband (Task 7 portfolio), Gantt 6 Wo + Turnover (Task 4/7), nächste 5 Anreisen + Turnover-Flag (Task 7), KPI-Tabelle Belegung/Umsatz/Δ/Buchungen/ADR (Task 2/7), Forecast OTB+Pickup portfolio+pro Property mit Konfidenzband + lowData (Task 3/7), Config-Block + Scheduler + Test-Script + Docs (Tasks 1/8/9/10). All spec sections map to a task.
- **YAGNI honored:** no YoY, no conversion column, no per-recipient variants.
- **Type consistency:** `MonthForecast`, `GanttGrid`, `BiReportModel` defined once and imported; repo function names (`getLeadTimeSamples`, `getRevenueForCheckInMonth`, `getOccupancyCounts`) consistent across Tasks 2/7.
- **Open implementation detail:** confidence-band formula fixed in Task 3 tests; turnover color `#3d5a80` fixed in Task 6.
