# Hostex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hostex.io als zweiter Booking-Provider neben Guesty anbinden, mit parallel-module-Architektur und ETL-Dispatch nach `provider`-Feld in `properties.json`. 3 Hostex-Properties direkt produktiv.

**Architecture:** Parallele Module unter `src/.../hostex/` ohne Guesty-Refactoring. ETL-Job dispatched pro Property nach `provider`. Bestehende DB-Schema, Repositories, Routes, Frontend bleiben unverändert. Spec: `docs/superpowers/specs/2026-05-13-hostex-integration-design.md`.

**Tech Stack:** TypeScript strict ESM, better-sqlite3, Bottleneck, Vitest, zod, fetch (built-in).

---

## File Structure

**Neu:**
- `src/types/hostex.ts` — API-Response-Typen
- `src/services/hostex-client.ts` — HTTP-Client mit Bottleneck-Rate-Limit
- `src/mappers/hostex/property-mapper.ts` + `property-mapper.test.ts`
- `src/mappers/hostex/reservation-mapper.ts` + `reservation-mapper.test.ts`
- `src/mappers/hostex/calendar-mapper.ts` + `calendar-mapper.test.ts`
- `src/jobs/hostex/sync-properties.ts`
- `src/jobs/hostex/sync-reservations.ts`
- `src/jobs/hostex/sync-calendar.ts`
- `src/scripts/test-hostex-sync.ts` — manueller Live-Test pro Property
- `src/test-fixtures/hostex/properties.json` — Test-Fixture aus Live-API
- `src/test-fixtures/hostex/reservations.json`
- `src/test-fixtures/hostex/calendar.json`

**Modifiziert (minimal):**
- `src/config/index.ts` — neue env-var `HOSTEX_ACCESS_TOKEN` + URL-Defaults
- `src/config/properties.ts` — Zod-Schema erweitert um `provider` + `static`
- `src/jobs/etl-job.ts` — Dispatch nach `provider` in `runETLJobForProperty`

**Nicht angefasst:** DB-Schema, Repositories, Routes, Frontend, Scheduler, alle Guesty-Module.

---

### Task 1: Config + Environment-Schema erweitern

**Files:**
- Modify: `src/config/index.ts`

- [ ] **Step 1: configSchema erweitern**

In `src/config/index.ts` finde den Block:

```ts
  guestyClientId: z.string().min(1, 'GUESTY_CLIENT_ID is required'),
  guestyClientSecret: z.string().min(1, 'GUESTY_CLIENT_SECRET is required'),
  guestyApiUrl: z.string().url().default('https://open-api.guesty.com/v1'),
  guestyOAuthUrl: z.string().url().default('https://open-api.guesty.com/oauth2/token'),
  guestyPropertyId: z.string().optional(), // Optional - falls back to properties.json
  propertiesConfigPath: z.string().default('./data/properties.json'),
```

Direkt darunter (vor `propertyCurrency`) einfügen:

```ts
  // Hostex API (optional — only required if hostex-provider properties exist)
  hostexAccessToken: z.string().optional(),
  hostexApiUrl: z.string().url().default('https://api.hostex.io/v3'),
```

- [ ] **Step 2: rawConfig in `parseConfig()` erweitern**

Im Block `const rawConfig = { ... }` nach der Zeile `guestyPropertyId: process.env.GUESTY_PROPERTY_ID,` einfügen:

```ts
    hostexAccessToken: process.env.HOSTEX_ACCESS_TOKEN,
    hostexApiUrl: process.env.HOSTEX_API_URL,
```

- [ ] **Step 3: Build prüfen**

Run: `npm run build`
Expected: Build erfolgreich, keine TS-Errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts
git commit -m "feat: add HOSTEX_ACCESS_TOKEN config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: properties.json Zod-Schema erweitern

**Files:**
- Modify: `src/config/properties.ts`

- [ ] **Step 1: Static-Config-Interface ergänzen**

In `src/config/properties.ts` nach dem `WeeklyReportConfig`-Interface (ungefähr Zeile 47) einfügen:

```ts
/**
 * Static config for hostex providers — fills fields Hostex API doesn't expose.
 */
export interface PropertyStaticConfig {
  accommodates: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  propertyType?: string | null;
  extraPersonFee?: number;
  guestsIncluded?: number;
  weeklyPriceFactor?: number;
  monthlyPriceFactor?: number;
  taxes?: Array<{
    type: string;
    amount: number;
    units: 'PERCENTAGE' | 'FIXED';
    quantifier: 'PER_NIGHT' | 'PER_STAY' | 'PER_GUEST' | 'PER_GUEST_PER_NIGHT';
    appliedToAllFees?: boolean;
    appliedOnFees?: string[];
  }>;
  basePrice?: number | null;
  cleaningFee?: number | null;
  minNights?: number | null;
  maxNights?: number | null;
}
```

- [ ] **Step 2: `PropertyConfig` Interface erweitern**

Finde das Interface (ca. Zeile 51-62):

```ts
export interface PropertyConfig {
  slug: string;
  guestyPropertyId: string;
  name: string;
  timezone: string;
  currency: string;
  bookingRecipientEmail: string;
  bookingSenderName: string;
  weeklyReport: WeeklyReportConfig;
  ga4?: GA4Config;
  googleCalendar?: GoogleCalendarConfig;
}
```

Ersetze durch:

```ts
export interface PropertyConfig {
  slug: string;
  provider: 'guesty' | 'hostex';
  guestyPropertyId?: string;
  hostexPropertyId?: string;
  name: string;
  timezone: string;
  currency: string;
  bookingRecipientEmail: string;
  bookingSenderName: string;
  weeklyReport: WeeklyReportConfig;
  ga4?: GA4Config;
  googleCalendar?: GoogleCalendarConfig;
  static?: PropertyStaticConfig;
}
```

- [ ] **Step 3: Zod-Schemas erweitern**

Finde den Block `const propertyConfigSchema = z.object({ ... })` (ca. Zeile 88-99) und ersetze ihn komplett durch:

```ts
const taxConfigSchema = z.object({
  type: z.string(),
  amount: z.number(),
  units: z.enum(['PERCENTAGE', 'FIXED']),
  quantifier: z.enum(['PER_NIGHT', 'PER_STAY', 'PER_GUEST', 'PER_GUEST_PER_NIGHT']),
  appliedToAllFees: z.boolean().optional(),
  appliedOnFees: z.array(z.string()).optional(),
});

const propertyStaticConfigSchema = z.object({
  accommodates: z.number().int().min(1, 'static.accommodates is required and must be >= 1'),
  bedrooms: z.number().int().min(0).nullable().optional(),
  bathrooms: z.number().min(0).nullable().optional(),
  propertyType: z.string().nullable().optional(),
  extraPersonFee: z.number().min(0).optional(),
  guestsIncluded: z.number().int().min(1).optional(),
  weeklyPriceFactor: z.number().positive().optional(),
  monthlyPriceFactor: z.number().positive().optional(),
  taxes: z.array(taxConfigSchema).optional(),
  basePrice: z.number().nullable().optional(),
  cleaningFee: z.number().nullable().optional(),
  minNights: z.number().int().min(1).nullable().optional(),
  maxNights: z.number().int().min(1).nullable().optional(),
});

const propertyConfigSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  provider: z.enum(['guesty', 'hostex']).default('guesty'),
  guestyPropertyId: z.string().optional(),
  hostexPropertyId: z.string().optional(),
  name: z.string().min(1),
  timezone: z.string().default('Europe/Berlin'),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  bookingRecipientEmail: z.string().email(),
  bookingSenderName: z.string().min(1),
  weeklyReport: weeklyReportConfigSchema,
  ga4: ga4ConfigSchema.optional().default({ enabled: false }),
  googleCalendar: googleCalendarConfigSchema.optional().default({ enabled: false }),
  static: propertyStaticConfigSchema.optional(),
}).refine(
  (data) => {
    if (data.provider === 'guesty') return !!data.guestyPropertyId;
    if (data.provider === 'hostex') return !!data.hostexPropertyId;
    return false;
  },
  {
    message: 'guestyPropertyId is required when provider=guesty; hostexPropertyId is required when provider=hostex',
    path: ['provider'],
  }
).refine(
  (data) => {
    if (data.provider === 'hostex') return !!data.static;
    return true;
  },
  {
    message: 'static block is required when provider=hostex',
    path: ['static'],
  }
);
```

- [ ] **Step 4: Helper-Funktion `getPropertiesByProvider` ergänzen**

In `src/config/properties.ts`, nach der Funktion `getPropertyByGuestyId` einfügen:

```ts
/**
 * Get all properties for a specific provider
 */
export function getPropertiesByProvider(provider: 'guesty' | 'hostex'): PropertyConfig[] {
  return loadPropertiesConfig().filter((p) => p.provider === provider);
}

/**
 * Get a property by its Hostex property ID
 */
export function getPropertyByHostexId(hostexId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.hostexPropertyId === hostexId);
}
```

- [ ] **Step 5: Build + Existing Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle 55 bestehenden Tests (guest-fingerprint) bestehen weiter.

- [ ] **Step 6: Properties.json laden noch nicht testen**

Die existierende `data/properties.json` hat keine `provider`-Feld — defaultet auf `guesty`, sollte weiter laden. Stichprobe:

```bash
node -e "import('./dist/config/properties.js').then(m => console.log(m.loadPropertiesConfig().map(p => ({slug: p.slug, provider: p.provider}))))"
```
Expected: `[{slug: 'farmhouse', provider: 'guesty'}, {slug: 'u19', provider: 'guesty'}]`

- [ ] **Step 7: Commit**

```bash
git add src/config/properties.ts
git commit -m "feat: extend properties schema with provider + static config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Hostex API-Type-Definitionen

**Files:**
- Create: `src/types/hostex.ts`

- [ ] **Step 1: Datei mit allen relevanten Typen anlegen**

Datei `src/types/hostex.ts`:

```ts
/**
 * Hostex API Type Definitions
 *
 * Based on live-tested responses from /v3/properties, /v3/reservations,
 * /v3/listings/calendar. Only the fields we actually consume are typed.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

/**
 * Common envelope returned by all Hostex API endpoints
 */
export interface HostexEnvelope<T> {
  request_id: string;
  error_code: number; // 200 = success
  error_msg: string;
  data: T;
}

/**
 * Property — from GET /v3/properties
 */
export interface HostexProperty {
  id: number;
  title: string;
  channels: Array<{
    channel_type: string; // e.g. "airbnb"
    listing_id: string;   // channel-specific listing identifier
    currency: string;
  }>;
  default_checkin_time?: string;  // "15:00"
  default_checkout_time?: string; // "12:00"
  timezone?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  wifi_ssid?: string;
  wifi_password?: string;
  wifi_remarks?: string;
}

/**
 * Reservation rate detail line item
 */
export interface HostexRateDetail {
  type: string; // ACCOMMODATION, CLEANING_FEE, HOST_SERVICE_FEE, ...
  description: string;
  currency: string;
  amount: number;
}

/**
 * Reservation — from GET /v3/reservations
 */
export interface HostexReservation {
  reservation_code: string;
  stay_code: string;
  channel_id: string;
  channel_type: string;
  listing_id: string;
  property_id: number;
  status: 'wait_accept' | 'wait_pay' | 'accepted' | 'cancelled' | 'denied' | 'timeout' | string;
  stay_status?: 'checkin_pending' | 'in_house' | 'stay_completed' | string;
  check_in_date: string;  // "YYYY-MM-DD"
  check_out_date: string; // "YYYY-MM-DD"
  number_of_guests?: number;
  number_of_adults?: number;
  number_of_children?: number;
  number_of_infants?: number;
  number_of_pets?: number;
  guest_name?: string;
  guest_phone?: string;
  guest_email?: string;
  cancelled_at?: string | null;
  booked_at?: string;
  created_at?: string;
  creator?: string;
  rates?: {
    total_rate?: { currency: string; amount: number };
    total_commission?: { currency: string; amount: number };
    rate?: { currency: string; amount: number };
    commission?: { currency: string; amount: number };
    details?: HostexRateDetail[];
  };
  conversation_id?: string;
  remarks?: string;
}

/**
 * Calendar day — from POST /v3/listings/calendar
 */
export interface HostexCalendarDay {
  date: string; // "YYYY-MM-DD"
  price: number;
  inventory: number; // 0 or 1 (0 = blocked/booked, 1 = available)
  restrictions: {
    min_stay_on_arrival: number;
    max_stay_on_arrival: number;
    closed_on_arrival: boolean;
    closed_on_departure: boolean;
  };
}

/**
 * Listing calendar entry (one per requested listing)
 */
export interface HostexListingCalendar {
  listing_id: string;
  channel_type: string;
  calendar: HostexCalendarDay[];
}

export interface HostexCalendarResponse {
  listings: HostexListingCalendar[];
}

/**
 * Wrapper for query responses
 */
export interface HostexPropertiesData { properties: HostexProperty[] }
export interface HostexReservationsData { reservations: HostexReservation[] }
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build`
Expected: Build erfolgreich.

- [ ] **Step 3: Commit**

```bash
git add src/types/hostex.ts
git commit -m "feat: add Hostex API type definitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Test-Fixtures aus Live-API kopieren

**Files:**
- Create: `src/test-fixtures/hostex/properties.json`
- Create: `src/test-fixtures/hostex/reservations.json`
- Create: `src/test-fixtures/hostex/calendar.json`

- [ ] **Step 1: Directory anlegen**

Run: `mkdir -p src/test-fixtures/hostex`
Expected: Directory existiert.

- [ ] **Step 2: Live-Response-Fixtures aus /tmp ins Repo kopieren, mit Sensitive-Daten-Masking**

Run:
```bash
node <<'EOF'
const fs = require('fs');

// Properties: keine sensitiven Daten, direkt kopieren
fs.writeFileSync(
  'src/test-fixtures/hostex/properties.json',
  fs.readFileSync('/tmp/hostex-properties.json')
);

// Reservations: guest_email und guest_phone maskieren
const res = JSON.parse(fs.readFileSync('/tmp/hostex-reservations.json'));
for (const r of res.data.reservations) {
  if (r.guest_email) r.guest_email = 'masked@example.com';
  if (r.guest_phone) r.guest_phone = '+49 0000000000';
}
fs.writeFileSync('src/test-fixtures/hostex/reservations.json', JSON.stringify(res, null, 2));

// Calendar: keine sensitiven Daten
fs.writeFileSync(
  'src/test-fixtures/hostex/calendar.json',
  fs.readFileSync('/tmp/hostex-calendar.json')
);

console.log('Fixtures copied + masked');
EOF
```
Expected: `Fixtures copied + masked`. Drei JSON-Dateien existieren.

- [ ] **Step 3: Verifikation**

Run: `ls -la src/test-fixtures/hostex/`
Expected: 3 Dateien.

Run: `node -e "const j=require('./src/test-fixtures/hostex/reservations.json'); console.log(j.data.reservations[0].guest_email, j.data.reservations[0].guest_phone)"`
Expected: `masked@example.com +49 0000000000`

- [ ] **Step 4: Commit**

```bash
git add src/test-fixtures/hostex/
git commit -m "test: add Hostex API response fixtures from live tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Hostex Client — Skelett + getProperties

**Files:**
- Create: `src/services/hostex-client.ts`

- [ ] **Step 1: Client-Klasse mit Wrapper-Auspack**

Datei `src/services/hostex-client.ts`:

```ts
/**
 * Hostex API Client
 *
 * HTTP client for Hostex Open API v3 with Bottleneck rate limiting and
 * exponential-backoff retries. Authenticates via static Hostex-Access-Token
 * header. Unwraps the response envelope so callers see `data` directly.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import Bottleneck from 'bottleneck';
import { config } from '../config/index.js';
import { ExternalApiError } from '../utils/errors.js';
import logger, { logApiCall } from '../utils/logger.js';
import type {
  HostexEnvelope,
  HostexProperty,
  HostexPropertiesData,
  HostexReservation,
  HostexReservationsData,
  HostexCalendarResponse,
} from '../types/hostex.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HostexClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly limiter: Bottleneck;

  constructor(
    accessToken: string | undefined = config.hostexAccessToken,
    baseUrl: string = config.hostexApiUrl,
  ) {
    if (!accessToken) {
      throw new Error('HOSTEX_ACCESS_TOKEN is required to construct HostexClient');
    }
    this.accessToken = accessToken;
    this.baseUrl = baseUrl.replace(/\/$/, '');

    // Conservative: 60 requests/min host-wide (1200 cap), 10 concurrent, 1s between.
    this.limiter = new Bottleneck({
      reservoir: 60,
      reservoirRefreshAmount: 60,
      reservoirRefreshInterval: 60_000,
      maxConcurrent: 10,
      minTime: 1000,
    });

    this.limiter.on('depleted', () => {
      logger.debug('Hostex rate limiter reservoir depleted, requests will queue');
    });
  }

  /**
   * Generic call that unwraps the Hostex envelope and applies retries.
   */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        const response = await this.limiter.schedule(() =>
          fetch(url, {
            method,
            headers: {
              'Hostex-Access-Token': this.accessToken,
              'User-Agent': 'guesty-calendar-app',
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          })
        );
        const duration = Date.now() - startTime;
        logApiCall('Hostex', path, response.status, duration);

        // 429 handling: exponential backoff (1s, 2s, 4s, 8s, 16s) — no Retry-After header
        if (response.status === 429) {
          if (attempt >= maxRetries) {
            throw new ExternalApiError(
              `Hostex rate limit exceeded after ${maxRetries + 1} attempts`,
              429,
              'Hostex',
              { path },
            );
          }
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, delayMs, path }, 'Hostex 429, backing off');
          await sleep(delayMs);
          continue;
        }

        // 5xx / network errors: retry with linear backoff (1s, 2s, 4s), max 3 retries
        if (!response.ok && response.status >= 500 && attempt < 3) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, status: response.status, delayMs, path }, 'Hostex 5xx, retrying');
          await sleep(delayMs);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new ExternalApiError(
            `Hostex HTTP ${response.status}: ${text}`,
            response.status,
            'Hostex',
            { path },
          );
        }

        const envelope = (await response.json()) as HostexEnvelope<T>;
        if (envelope.error_code !== 200) {
          throw new ExternalApiError(
            `Hostex ${envelope.error_code}: ${envelope.error_msg} (request_id=${envelope.request_id})`,
            envelope.error_code,
            'Hostex',
            { path, request_id: envelope.request_id },
          );
        }
        return envelope.data;
      } catch (error) {
        lastError = error as Error;
        // Network-level errors: retry with backoff if attempts remain
        if (!(error instanceof ExternalApiError) && attempt < 3) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, delayMs, path, error: lastError.message }, 'Hostex network error, retrying');
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Hostex request failed (unknown reason)');
  }

  /**
   * GET /v3/properties — list all properties
   */
  async getProperties(): Promise<HostexProperty[]> {
    const data = await this.call<HostexPropertiesData>('GET', '/properties?limit=100');
    return data.properties;
  }

  /**
   * GET /v3/reservations — list reservations with pagination
   * Implemented in Task 6.
   */
  async getReservations(_opts: {
    propertyId?: string;
    startCheckIn?: string;
    endCheckIn?: string;
  } = {}): Promise<HostexReservation[]> {
    throw new Error('Not implemented yet — see Task 6');
  }

  /**
   * POST /v3/listings/calendar — calendar for one or more listings
   * Implemented in Task 7.
   */
  async getListingCalendars(_opts: {
    startDate: string;
    endDate: string;
    listings: Array<{ channel_type: string; listing_id: string }>;
  }): Promise<HostexCalendarResponse> {
    throw new Error('Not implemented yet — see Task 7');
  }
}

/**
 * Singleton instance. Throws on construction if HOSTEX_ACCESS_TOKEN is missing,
 * so callers that import this MUST guard with `if (someProperty.provider === 'hostex')`.
 */
let _client: HostexClient | null = null;
export function getHostexClient(): HostexClient {
  if (!_client) _client = new HostexClient();
  return _client;
}
```

- [ ] **Step 2: Build + tests laufen lassen**

Run: `npm run build && npm test -- --run`
Expected: Build clean, 55 bestehende Tests bestehen weiter.

- [ ] **Step 3: Commit**

```bash
git add src/services/hostex-client.ts
git commit -m "feat: add Hostex client skeleton with getProperties

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Hostex Client — getReservations mit Pagination

**Files:**
- Modify: `src/services/hostex-client.ts`

- [ ] **Step 1: Implementierung von `getReservations`**

In `src/services/hostex-client.ts` ersetze die Stub-Implementation:

```ts
  async getReservations(_opts: {
    propertyId?: string;
    startCheckIn?: string;
    endCheckIn?: string;
  } = {}): Promise<HostexReservation[]> {
    throw new Error('Not implemented yet — see Task 6');
  }
```

Durch:

```ts
  async getReservations(opts: {
    propertyId?: string;
    startCheckIn?: string;
    endCheckIn?: string;
  } = {}): Promise<HostexReservation[]> {
    const limit = 100;
    let offset = 0;
    const all: HostexReservation[] = [];
    const safetyMax = 1000; // hard cap to avoid runaway pagination

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (opts.propertyId) params.set('property_id', opts.propertyId);
      if (opts.startCheckIn) params.set('start_check_in_date', opts.startCheckIn);
      if (opts.endCheckIn) params.set('end_check_in_date', opts.endCheckIn);

      const data = await this.call<HostexReservationsData>('GET', `/reservations?${params.toString()}`);
      const batch = data.reservations || [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
      if (all.length >= safetyMax) {
        logger.warn({ all: all.length, safetyMax }, 'Hostex getReservations hit safety cap, stopping pagination');
        break;
      }
    }
    return all;
  }
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/hostex-client.ts
git commit -m "feat: implement Hostex getReservations with pagination

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Hostex Client — getListingCalendars

**Files:**
- Modify: `src/services/hostex-client.ts`

- [ ] **Step 1: Implementierung**

Ersetze die Stub:

```ts
  async getListingCalendars(_opts: {
    startDate: string;
    endDate: string;
    listings: Array<{ channel_type: string; listing_id: string }>;
  }): Promise<HostexCalendarResponse> {
    throw new Error('Not implemented yet — see Task 7');
  }
```

Durch:

```ts
  async getListingCalendars(opts: {
    startDate: string;
    endDate: string;
    listings: Array<{ channel_type: string; listing_id: string }>;
  }): Promise<HostexCalendarResponse> {
    return this.call<HostexCalendarResponse>('POST', '/listings/calendar', {
      start_date: opts.startDate,
      end_date: opts.endDate,
      listings: opts.listings,
    });
  }
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, 55 Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/services/hostex-client.ts
git commit -m "feat: implement Hostex getListingCalendars

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Reservation Mapper (TDD)

**Files:**
- Create: `src/mappers/hostex/reservation-mapper.test.ts`
- Create: `src/mappers/hostex/reservation-mapper.ts`

- [ ] **Step 1: Failing tests schreiben**

Datei `src/mappers/hostex/reservation-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapHostexReservation } from './reservation-mapper.js';
import type { HostexReservation } from '../../types/hostex.js';

const baseRes: HostexReservation = {
  reservation_code: 'R-001',
  stay_code: 'R-001',
  channel_id: 'AIRBNB-XYZ',
  channel_type: 'airbnb',
  listing_id: '1635436646666826858',
  property_id: 12659676,
  status: 'accepted',
  check_in_date: '2026-06-01',
  check_out_date: '2026-06-03',
  number_of_guests: 2,
  number_of_adults: 2,
  number_of_children: 0,
  number_of_infants: 0,
  guest_name: 'Anke Morgenroth',
  rates: {
    total_rate: { currency: 'EUR', amount: 300 },
    total_commission: { currency: 'EUR', amount: 45 },
    details: [
      { type: 'ACCOMMODATION', description: 'Accommodation', currency: 'EUR', amount: 260 },
      { type: 'CLEANING_FEE', description: 'Cleaning fee', currency: 'EUR', amount: 40 },
      { type: 'HOST_SERVICE_FEE', description: 'Commission', currency: 'EUR', amount: 45 },
    ],
  },
  booked_at: '2026-05-01T10:00:00+00:00',
  created_at: '2026-05-01T10:00:00+00:00',
};

const defaultTimes = { checkIn: '15:00', checkOut: '12:00' };

describe('mapHostexReservation', () => {
  describe('Status-Routing', () => {
    it('accepted → confirmed in both tables', () => {
      const { asInquiry, asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('confirmed');
    });

    it('wait_pay → reserved in both tables', () => {
      const r = { ...baseRes, status: 'wait_pay' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('reserved');
      expect(asReservation!.status).toBe('reserved');
    });

    it('wait_accept → inquiry only', () => {
      const r = { ...baseRes, status: 'wait_accept' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).toBeNull();
    });

    it('cancelled → canceled inquiry only', () => {
      const r = { ...baseRes, status: 'cancelled' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('canceled');
      expect(asReservation).toBeNull();
    });

    it('denied → declined inquiry only', () => {
      const r = { ...baseRes, status: 'denied' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('declined');
      expect(asReservation).toBeNull();
    });

    it('timeout → expired inquiry only', () => {
      const r = { ...baseRes, status: 'timeout' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('expired');
      expect(asReservation).toBeNull();
    });

    it('unknown status → defensive reserved in both tables', () => {
      const r = { ...baseRes, status: 'some_new_status' };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('reserved');
    });
  });

  describe('Financial fields', () => {
    it('host_payout = total_rate - total_commission', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.host_payout).toBe(255); // 300 - 45
      expect(asReservation!.total_price).toBe(300);
    });

    it('handles missing rates gracefully', () => {
      const r = { ...baseRes, rates: undefined };
      const { asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asReservation!.host_payout).toBe(0);
      expect(asReservation!.total_price).toBe(0);
    });
  });

  describe('Date/time composition', () => {
    it('combines check_in_date with defaultCheckIn time as ISO', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.check_in).toBe('2026-06-01T15:00:00.000Z');
      expect(asReservation!.check_out).toBe('2026-06-03T12:00:00.000Z');
    });
  });

  describe('Identifiers', () => {
    it('reservation_id = Hostex reservation_code', () => {
      const { asReservation, asInquiry } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.reservation_id).toBe('R-001');
      expect(asInquiry.inquiry_id).toBe('R-001');
    });

    it('listing_id = Hostex property_id as string', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.listing_id).toBe('12659676');
    });

    it('source = Hostex channel_type', () => {
      const { asReservation, asInquiry } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.source).toBe('airbnb');
      expect(asInquiry.source).toBe('airbnb');
    });
  });

  describe('Guest fingerprint', () => {
    it('integrates fingerprintGuestSafe', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.internal_guest_id).toBe('anke_morgenroth');
      expect(asReservation!.guest_company).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/mappers/hostex/reservation-mapper.test.ts`
Expected: Tests scheitern wegen "Cannot find module './reservation-mapper.js'".

- [ ] **Step 3: Implementation schreiben**

Datei `src/mappers/hostex/reservation-mapper.ts`:

```ts
/**
 * Hostex Reservation Mapper
 *
 * Maps a Hostex reservation to the internal data model. Returns BOTH an
 * inquiry-row (always written, for BI history) and optionally a
 * reservation-row (only for active bookings, blocks calendar).
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import { fingerprintGuest } from '../../utils/guest-fingerprint.js';
import logger from '../../utils/logger.js';
import type { HostexReservation } from '../../types/hostex.js';
import type { Reservation } from '../../types/models.js';

export interface MappedInquiry {
  inquiry_id: string;
  listing_id: string;
  status: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guests_count: number | null;
  source: string | null;
  created_at_guesty: string | null;
  last_synced_at: string;
}

export interface MappedReservationResult {
  asInquiry: MappedInquiry;
  asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> | null;
}

const STATUS_TO_INQUIRY: Record<string, string> = {
  accepted: 'confirmed',
  wait_pay: 'reserved',
  wait_accept: 'inquiry',
  cancelled: 'canceled',
  denied: 'declined',
  timeout: 'expired',
};

const ACTIVE_HOSTEX_STATUSES = new Set(['accepted', 'wait_pay']);

function fingerprintSafe(name: string | null) {
  try {
    const fp = fingerprintGuest(name);
    return { internal_guest_id: fp.id, guest_company: fp.company };
  } catch (error) {
    logger.warn({ error, name }, 'fingerprintGuest threw, falling back to nulls');
    return { internal_guest_id: null, guest_company: null };
  }
}

export function mapHostexReservation(
  res: HostexReservation,
  defaultTimes: { checkIn: string; checkOut: string }
): MappedReservationResult {
  const now = new Date().toISOString();
  const listingId = String(res.property_id);
  const guestName = res.guest_name ?? null;
  const fp = fingerprintSafe(guestName);

  // Status routing
  let inquiryStatus = STATUS_TO_INQUIRY[res.status];
  let reservationStatus: string | null = null;
  let unknownStatus = false;
  if (!inquiryStatus) {
    unknownStatus = true;
    inquiryStatus = 'inquiry';
    reservationStatus = 'reserved'; // defensive — block calendar
    logger.warn(
      { reservation_code: res.reservation_code, hostex_status: res.status },
      'Unknown Hostex status, mapping defensively'
    );
  } else if (ACTIVE_HOSTEX_STATUSES.has(res.status)) {
    reservationStatus = res.status === 'accepted' ? 'confirmed' : 'reserved';
  }

  // Compose ISO check-in/out by combining DATE with default time.
  const checkInIso = `${res.check_in_date}T${defaultTimes.checkIn}:00.000Z`;
  const checkOutIso = `${res.check_out_date}T${defaultTimes.checkOut}:00.000Z`;

  // Nights count from dates
  const nights = Math.round(
    (Date.parse(`${res.check_out_date}T00:00:00Z`) - Date.parse(`${res.check_in_date}T00:00:00Z`)) /
      (1000 * 60 * 60 * 24)
  );

  // Financials
  const totalPrice = res.rates?.total_rate?.amount ?? 0;
  const totalCommission = res.rates?.total_commission?.amount ?? 0;
  const hostPayout = totalPrice - totalCommission;

  const asInquiry: MappedInquiry = {
    inquiry_id: res.reservation_code,
    listing_id: listingId,
    status: inquiryStatus,
    check_in: res.check_in_date,
    check_out: res.check_out_date,
    guest_name: guestName,
    guests_count: res.number_of_guests ?? null,
    source: res.channel_type ?? null,
    created_at_guesty: res.created_at ?? res.booked_at ?? null,
    last_synced_at: now,
  };

  if (!reservationStatus) {
    return { asInquiry, asReservation: null };
  }

  const asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> = {
    reservation_id: res.reservation_code,
    listing_id: listingId,
    check_in: checkInIso,
    check_out: checkOutIso,
    check_in_localized: res.check_in_date,
    check_out_localized: res.check_out_date,
    nights_count: nights,
    guest_id: null,
    guest_name: guestName,
    guests_count: res.number_of_guests ?? null,
    adults_count: res.number_of_adults ?? null,
    children_count: res.number_of_children ?? null,
    infants_count: res.number_of_infants ?? null,
    status: reservationStatus,
    confirmation_code: res.channel_id ?? null,
    source: res.channel_type ?? null,
    platform: res.channel_type ?? null,
    planned_arrival: null,
    planned_departure: null,
    currency: res.rates?.total_rate?.currency ?? null,
    total_price: totalPrice,
    host_payout: hostPayout,
    balance_due: null,
    total_paid: null,
    created_at_guesty: res.created_at ?? res.booked_at ?? null,
    reserved_at: res.booked_at ?? null,
    last_synced_at: now,
    internal_guest_id: fp.internal_guest_id,
    guest_company: fp.guest_company,
  };

  // Suppress unused-var lint when only declared
  void unknownStatus;

  return { asInquiry, asReservation };
}
```

- [ ] **Step 4: Tests laufen, GREEN bestätigen**

Run: `npm test -- --run src/mappers/hostex/reservation-mapper.test.ts`
Expected: Alle 14 Tests bestehen.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/hostex/reservation-mapper.ts src/mappers/hostex/reservation-mapper.test.ts
git commit -m "feat: implement Hostex reservation mapper with status routing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Calendar Mapper (TDD)

**Files:**
- Create: `src/mappers/hostex/calendar-mapper.test.ts`
- Create: `src/mappers/hostex/calendar-mapper.ts`

- [ ] **Step 1: Failing tests schreiben**

Datei `src/mappers/hostex/calendar-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapHostexCalendarDay } from './calendar-mapper.js';
import type { HostexCalendarDay, HostexReservation } from '../../types/hostex.js';

const baseDay: HostexCalendarDay = {
  date: '2026-06-01',
  price: 149,
  inventory: 1,
  restrictions: {
    min_stay_on_arrival: 2,
    max_stay_on_arrival: 30,
    closed_on_arrival: false,
    closed_on_departure: false,
  },
};

const resOverlapping: HostexReservation = {
  reservation_code: 'R-001',
  stay_code: 'R-001',
  channel_id: 'AIRBNB-XYZ',
  channel_type: 'airbnb',
  listing_id: 'L1',
  property_id: 12659676,
  status: 'accepted',
  check_in_date: '2026-06-01',
  check_out_date: '2026-06-03',
};

describe('mapHostexCalendarDay', () => {
  it('available day with no reservation', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('available');
    expect(out.block_type).toBeNull();
    expect(out.block_ref).toBeNull();
  });

  it('booked day: reservation overlaps', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [resOverlapping],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('booked');
    expect(out.block_type).toBe('reservation');
    expect(out.block_ref).toBe('R-001');
  });

  it('blocked day: inventory=0 without reservation', () => {
    const day: HostexCalendarDay = { ...baseDay, inventory: 0 };
    const out = mapHostexCalendarDay({
      day,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('blocked');
    expect(out.block_type).toBeNull();
  });

  it('reservation takes priority over inventory=0', () => {
    const day: HostexCalendarDay = { ...baseDay, inventory: 0 };
    const out = mapHostexCalendarDay({
      day,
      listingId: '12659676',
      reservationsForDate: [resOverlapping],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.status).toBe('booked');
  });

  it('price + restrictions are passed through', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.price).toBe(149);
    expect(out.min_nights).toBe(2);
    expect(out.closed_to_arrival).toBe(false);
    expect(out.closed_to_departure).toBe(false);
  });

  it('listing_id + date are persisted', () => {
    const out = mapHostexCalendarDay({
      day: baseDay,
      listingId: '12659676',
      reservationsForDate: [],
      lastSyncedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(out.listing_id).toBe('12659676');
    expect(out.date).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/mappers/hostex/calendar-mapper.test.ts`
Expected: Tests scheitern wegen "Cannot find module './calendar-mapper.js'".

- [ ] **Step 3: Implementation schreiben**

Datei `src/mappers/hostex/calendar-mapper.ts`:

```ts
/**
 * Hostex Calendar Mapper
 *
 * Maps a Hostex calendar day to the internal Availability model. Status is
 * derived from inventory + overlapping reservations.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import type { HostexCalendarDay, HostexReservation } from '../../types/hostex.js';
import type { Availability } from '../../types/models.js';

export function mapHostexCalendarDay(args: {
  day: HostexCalendarDay;
  listingId: string;
  reservationsForDate: HostexReservation[];
  lastSyncedAt: string;
}): Omit<Availability, 'id' | 'created_at' | 'updated_at'> {
  const { day, listingId, reservationsForDate, lastSyncedAt } = args;

  let status: 'available' | 'blocked' | 'booked';
  let blockType: Availability['block_type'] = null;
  let blockRef: string | null = null;

  if (reservationsForDate.length > 0) {
    status = 'booked';
    blockType = 'reservation';
    blockRef = reservationsForDate[0].reservation_code;
  } else if (day.inventory === 0) {
    status = 'blocked';
  } else {
    status = 'available';
  }

  return {
    listing_id: listingId,
    date: day.date,
    status,
    price: day.price,
    min_nights: day.restrictions.min_stay_on_arrival,
    closed_to_arrival: day.restrictions.closed_on_arrival,
    closed_to_departure: day.restrictions.closed_on_departure,
    block_type: blockType,
    block_ref: blockRef,
    last_synced_at: lastSyncedAt,
  };
}
```

- [ ] **Step 4: Tests laufen, GREEN bestätigen**

Run: `npm test -- --run src/mappers/hostex/calendar-mapper.test.ts`
Expected: 6 Tests bestehen.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/hostex/calendar-mapper.ts src/mappers/hostex/calendar-mapper.test.ts
git commit -m "feat: implement Hostex calendar mapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Property Mapper (TDD)

**Files:**
- Create: `src/mappers/hostex/property-mapper.test.ts`
- Create: `src/mappers/hostex/property-mapper.ts`

- [ ] **Step 1: Failing tests schreiben**

Datei `src/mappers/hostex/property-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapHostexProperty } from './property-mapper.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';
import type { PropertyConfig } from '../../config/properties.js';

const hostexProperty: HostexProperty = {
  id: 12659676,
  title: 'Alte Schilderwerkstatt',
  channels: [{ channel_type: 'airbnb', listing_id: 'L1', currency: 'EUR' }],
  default_checkin_time: '15:00',
  default_checkout_time: '12:00',
  timezone: 'Europe/Berlin',
};

const basePropertyConfig: PropertyConfig = {
  slug: 'alte-schilderwerkstatt',
  provider: 'hostex',
  hostexPropertyId: '12659676',
  name: 'Alte Schilderwerkstatt',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  bookingRecipientEmail: 'a@b.de',
  bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 9 },
  ga4: { enabled: false },
  googleCalendar: { enabled: false },
  static: { accommodates: 4 },
};

const calendarSample: HostexCalendarDay[] = [
  { date: '2026-06-01', price: 129, inventory: 1, restrictions: { min_stay_on_arrival: 1, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-02', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-03', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-04', price: 199, inventory: 1, restrictions: { min_stay_on_arrival: 3, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-05', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
];

const recentReservations: HostexReservation[] = [
  { reservation_code: 'R1', stay_code: 'R1', channel_id: 'a', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-01', check_out_date: '2026-04-02',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 20 }] } },
  { reservation_code: 'R2', stay_code: 'R2', channel_id: 'b', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-05', check_out_date: '2026-04-06',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 25 }] } },
  { reservation_code: 'R3', stay_code: 'R3', channel_id: 'c', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-10', check_out_date: '2026-04-11',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 30 }] } },
];

describe('mapHostexProperty', () => {
  describe('basic fields', () => {
    it('id from hostexProperty.id as string', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.id).toBe('12659676');
    });
    it('title pass-through', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.title).toBe('Alte Schilderwerkstatt');
    });
    it('active is always true', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.active).toBe(true);
    });
  });

  describe('Static-First (priority over Dynamic and API)', () => {
    it('static.basePrice wins over calendar median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, basePrice: 500 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.base_price).toBe(500);
    });
    it('static.cleaningFee wins over reservation median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, cleaningFee: 99 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations, calendarSample: [] });
      expect(l.cleaning_fee).toBe(99);
    });
    it('static.minNights wins over restriction median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, minNights: 7 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.min_nights).toBe(7);
    });
    it('static.maxNights wins over restriction max', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, maxNights: 14 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.max_nights).toBe(14);
    });
  });

  describe('Dynamic-Fallback', () => {
    it('base_price = median calendar price when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.base_price).toBe(149); // median of [129, 149, 149, 199, 149]
    });
    it('cleaning_fee = median CLEANING_FEE from recent reservations', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations, calendarSample: [] });
      expect(l.cleaning_fee).toBe(25); // median of [20, 25, 30]
    });
    it('min_nights = median min_stay_on_arrival when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.min_nights).toBe(2); // median of [1, 2, 2, 3, 2]
    });
    it('max_nights = max max_stay_on_arrival when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.max_nights).toBe(365);
    });
  });

  describe('Final fallbacks', () => {
    it('base_price = 0 when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.base_price).toBe(0);
    });
    it('cleaning_fee = 0 when both static and reservations empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.cleaning_fee).toBe(0);
    });
    it('min_nights = 1 when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.min_nights).toBe(1);
    });
    it('max_nights = null when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.max_nights).toBeNull();
    });
  });

  describe('Static optional fields', () => {
    it('full static block populates everything', () => {
      const config = { ...basePropertyConfig, static: {
        accommodates: 6, bedrooms: 3, bathrooms: 2, propertyType: 'House',
        extraPersonFee: 30, guestsIncluded: 4, weeklyPriceFactor: 0.85, monthlyPriceFactor: 0.7,
        taxes: [{ type: 'VAT', amount: 7, units: 'PERCENTAGE' as const, quantifier: 'PER_NIGHT' as const }],
      } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample: [] });
      expect(l.accommodates).toBe(6);
      expect(l.bedrooms).toBe(3);
      expect(l.bathrooms).toBe(2);
      expect(l.property_type).toBe('House');
      expect(l.extra_person_fee).toBe(30);
      expect(l.guests_included).toBe(4);
      expect(l.weekly_price_factor).toBe(0.85);
      expect(l.monthly_price_factor).toBe(0.7);
      expect(l.taxes).toHaveLength(1);
      expect(l.taxes[0].type).toBe('VAT');
    });
    it('guests_included defaults to accommodates if not set', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.guests_included).toBe(4);
    });
  });

  describe('Check-in/out times', () => {
    it('googleCalendar.checkInTime wins over hostex default', () => {
      const config = { ...basePropertyConfig, googleCalendar: { enabled: true, checkInTime: '16:00', checkOutTime: '11:00' } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample: [] });
      expect(l.check_in_time).toBe('16:00');
      expect(l.check_out_time).toBe('11:00');
    });
    it('falls back to hostex default_checkin_time', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.check_in_time).toBe('15:00');
      expect(l.check_out_time).toBe('12:00');
    });
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/mappers/hostex/property-mapper.test.ts`
Expected: Tests scheitern wegen "Cannot find module".

- [ ] **Step 3: Implementation schreiben**

Datei `src/mappers/hostex/property-mapper.ts`:

```ts
/**
 * Hostex Property Mapper
 *
 * Builds the internal Listing model from three sources, applying
 * Static-First (properties.json `static` block) → Dynamic-Fallback
 * (median from Calendar/Reservations) → final defaults.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import logger from '../../utils/logger.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { Listing, Tax } from '../../types/models.js';

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function cleaningFeeMedian(reservations: HostexReservation[]): number | null {
  const fees = reservations
    .flatMap((r) => r.rates?.details ?? [])
    .filter((d) => d.type === 'CLEANING_FEE' && d.amount > 0)
    .map((d) => d.amount);
  return median(fees);
}

function basePriceMedian(calendar: HostexCalendarDay[]): number | null {
  const prices = calendar.map((d) => d.price).filter((p) => p > 0);
  return median(prices);
}

function minNightsMedian(calendar: HostexCalendarDay[]): number | null {
  const vals = calendar.map((d) => d.restrictions.min_stay_on_arrival).filter((v) => v > 0);
  return median(vals);
}

function maxNightsMax(calendar: HostexCalendarDay[]): number | null {
  if (calendar.length === 0) return null;
  return Math.max(...calendar.map((d) => d.restrictions.max_stay_on_arrival));
}

export function mapHostexProperty(args: {
  hostexProperty: HostexProperty;
  propertyConfig: PropertyConfig;
  recentReservations: HostexReservation[];
  calendarSample: HostexCalendarDay[];
}): Omit<Listing, 'created_at' | 'updated_at'> {
  const { hostexProperty, propertyConfig, recentReservations, calendarSample } = args;
  const stat = propertyConfig.static;
  if (!stat) {
    throw new Error(
      `mapHostexProperty called without static config for property ${propertyConfig.slug}`
    );
  }

  // base_price: static → median calendar → 0
  let basePrice = stat.basePrice ?? null;
  if (basePrice == null) {
    basePrice = basePriceMedian(calendarSample);
  }
  if (basePrice == null) {
    logger.warn(
      { slug: propertyConfig.slug },
      'No basePrice available (no static, empty calendar) — using 0'
    );
    basePrice = 0;
  }

  // cleaning_fee: static → median reservations → 0
  let cleaningFee = stat.cleaningFee ?? null;
  if (cleaningFee == null) {
    cleaningFee = cleaningFeeMedian(recentReservations);
  }
  if (cleaningFee == null) cleaningFee = 0;

  // min_nights: static → median calendar → 1
  let minNights = stat.minNights ?? null;
  if (minNights == null) {
    const med = minNightsMedian(calendarSample);
    minNights = med != null ? Math.round(med) : null;
  }
  if (minNights == null) minNights = 1;

  // max_nights: static → max calendar → null
  let maxNights: number | null = stat.maxNights ?? null;
  if (maxNights == null) {
    maxNights = maxNightsMax(calendarSample);
  }

  // currency: propertyConfig → first channel → "EUR"
  const currency =
    propertyConfig.currency ?? hostexProperty.channels[0]?.currency ?? 'EUR';

  // check-in/out times: googleCalendar → hostex default → null
  const checkInTime =
    propertyConfig.googleCalendar?.checkInTime ?? hostexProperty.default_checkin_time ?? null;
  const checkOutTime =
    propertyConfig.googleCalendar?.checkOutTime ?? hostexProperty.default_checkout_time ?? null;

  // guests_included: static → accommodates
  const guestsIncluded = stat.guestsIncluded ?? stat.accommodates;

  // taxes: static → [] (cast to Tax shape with synthesized id)
  const taxes: Tax[] = (stat.taxes ?? []).map((t, idx) => ({
    id: `static-${idx}`,
    type: t.type,
    amount: t.amount,
    units: t.units,
    quantifier: t.quantifier,
    appliedToAllFees: t.appliedToAllFees ?? false,
    appliedOnFees: t.appliedOnFees ?? [],
  }));

  return {
    id: String(hostexProperty.id),
    title: hostexProperty.title,
    nickname: propertyConfig.name ?? hostexProperty.title,
    accommodates: stat.accommodates,
    bedrooms: stat.bedrooms ?? null,
    bathrooms: stat.bathrooms ?? null,
    property_type: stat.propertyType ?? null,
    timezone: hostexProperty.timezone ?? propertyConfig.timezone ?? 'Europe/Berlin',
    currency,
    base_price: basePrice,
    weekend_base_price: null,
    cleaning_fee: cleaningFee,
    extra_person_fee: stat.extraPersonFee ?? 0,
    guests_included: guestsIncluded,
    weekly_price_factor: stat.weeklyPriceFactor ?? 1.0,
    monthly_price_factor: stat.monthlyPriceFactor ?? 1.0,
    taxes,
    min_nights: minNights,
    max_nights: maxNights,
    check_in_time: checkInTime,
    check_out_time: checkOutTime,
    active: true,
    last_synced_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Tests laufen, GREEN bestätigen**

Run: `npm test -- --run src/mappers/hostex/property-mapper.test.ts`
Expected: Alle 20 Tests bestehen.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/hostex/property-mapper.ts src/mappers/hostex/property-mapper.test.ts
git commit -m "feat: implement Hostex property mapper with Static-First fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: sync-reservations Job

**Files:**
- Create: `src/jobs/hostex/sync-reservations.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/hostex/sync-reservations.ts`:

```ts
/**
 * Hostex Sync Reservations
 *
 * Fetches all reservations for a Hostex property and persists them.
 * - All statuses → `inquiries` table (BI history pool)
 * - Active (accepted, wait_pay, unknown→reserved-defensive) → `reservations` table
 * - Stale reservations no longer in API are deleted from `reservations`
 *
 * Note: `inquiries` table is never cleaned up — analogous to Guesty sync.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { getDatabase } from '../../db/index.js';
import {
  upsertReservation,
  deleteStaleReservationsInRange,
} from '../../repositories/reservation-repository.js';
import { mapHostexReservation } from '../../mappers/hostex/reservation-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncResult {
  success: boolean;
  inquiriesCount: number;
  confirmedCount: number;
  error?: string;
}

export async function syncHostexReservations(property: PropertyConfig): Promise<SyncResult> {
  const startTime = Date.now();
  const hostexId = property.hostexPropertyId!;
  const slug = property.slug;

  try {
    logger.info({ slug, hostexId }, 'Hostex: starting reservation sync');

    const client = getHostexClient();
    const reservations = await client.getReservations({ propertyId: hostexId });

    logger.info({ slug, count: reservations.length }, 'Hostex: fetched reservations');

    const defaultTimes = {
      checkIn: property.googleCalendar?.checkInTime ?? '15:00',
      checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
    };

    const db = getDatabase();
    const upsertInquiry = db.prepare(`
      INSERT INTO inquiries (
        inquiry_id, listing_id, status, check_in, check_out,
        guest_name, guests_count, source, created_at_guesty, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inquiry_id) DO UPDATE SET
        status = excluded.status,
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        source = excluded.source,
        last_synced_at = excluded.last_synced_at
    `);

    let inquiriesCount = 0;
    let confirmedCount = 0;
    const keepReservationIds: string[] = [];

    const upsertAll = db.transaction((items: typeof reservations) => {
      for (const r of items) {
        const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
        upsertInquiry.run(
          asInquiry.inquiry_id,
          asInquiry.listing_id,
          asInquiry.status,
          asInquiry.check_in,
          asInquiry.check_out,
          asInquiry.guest_name,
          asInquiry.guests_count,
          asInquiry.source,
          asInquiry.created_at_guesty,
          asInquiry.last_synced_at,
        );
        inquiriesCount++;
        if (asReservation) {
          upsertReservation(asReservation);
          if (asReservation.status === 'confirmed') confirmedCount++;
          keepReservationIds.push(asReservation.reservation_id);
        }
      }
    });
    upsertAll(reservations);

    // Cleanup stale reservations in 24-month window (past 12 + future 12)
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    const end = new Date(now);
    end.setMonth(end.getMonth() + 12);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const deleted = deleteStaleReservationsInRange(hostexId, startStr, endStr, keepReservationIds);

    logger.info(
      { slug, inquiriesCount, confirmedCount, deletedStale: deleted, durationMs: Date.now() - startTime },
      'Hostex: reservation sync completed'
    );

    return { success: true, inquiriesCount, confirmedCount };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: reservation sync failed');
    return {
      success: false,
      inquiriesCount: 0,
      confirmedCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle bisherigen Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/hostex/sync-reservations.ts
git commit -m "feat: add Hostex sync-reservations job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: sync-calendar Job

**Files:**
- Create: `src/jobs/hostex/sync-calendar.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/hostex/sync-calendar.ts`:

```ts
/**
 * Hostex Sync Calendar
 *
 * Fetches 24 months of calendar data (12 back + 12 forward) for a property's
 * primary channel listing, looks up overlapping reservations from the DB,
 * and upserts availability rows.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { upsertAvailabilityBatch, deleteOldAvailability } from '../../repositories/availability-repository.js';
import { getReservationsInRange } from '../../repositories/reservation-repository.js';
import { mapHostexCalendarDay } from '../../mappers/hostex/calendar-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { HostexProperty, HostexReservation } from '../../types/hostex.js';

export interface SyncCalendarResult {
  success: boolean;
  daysCount: number;
  error?: string;
}

export async function syncHostexCalendar(
  property: PropertyConfig,
  hostexProperty: HostexProperty
): Promise<SyncCalendarResult> {
  const startTime = Date.now();
  const slug = property.slug;
  const listingId = String(hostexProperty.id);

  try {
    const channel = hostexProperty.channels[0];
    if (!channel) {
      throw new Error(`No channels configured for Hostex property ${listingId}`);
    }

    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    const end = new Date(now);
    end.setMonth(end.getMonth() + 12);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    logger.info({ slug, listingId, startStr, endStr }, 'Hostex: starting calendar sync');

    const client = getHostexClient();
    const calResp = await client.getListingCalendars({
      startDate: startStr,
      endDate: endStr,
      listings: [{ channel_type: channel.channel_type, listing_id: channel.listing_id }],
    });

    const listingCal = calResp.listings.find((l) => l.listing_id === channel.listing_id);
    if (!listingCal) {
      throw new Error(`Calendar response missing for listing ${channel.listing_id}`);
    }

    // Load reservations for overlap detection
    const reservations = getReservationsInRange(listingId, startStr, endStr);
    // Build lookup: date → reservations[]
    const resByDate = new Map<string, HostexReservation[]>();
    for (const day of listingCal.calendar) {
      const overlapping = reservations.filter((r) => {
        // reservation.check_in / check_out are ISO strings — extract date
        const ci = (r.check_in_localized ?? r.check_in).split('T')[0];
        const co = (r.check_out_localized ?? r.check_out).split('T')[0];
        return ci <= day.date && day.date < co;
      });
      // Adapter: we have internal Reservation, but mapper expects HostexReservation.
      // Construct minimal HostexReservation shape for mapper's reservationsForDate usage.
      const hostexLike: HostexReservation[] = overlapping.map((r) => ({
        reservation_code: r.reservation_id,
        stay_code: r.reservation_id,
        channel_id: r.confirmation_code ?? '',
        channel_type: r.source ?? '',
        listing_id: r.listing_id,
        property_id: Number(r.listing_id),
        status: 'accepted',
        check_in_date: (r.check_in_localized ?? r.check_in).split('T')[0],
        check_out_date: (r.check_out_localized ?? r.check_out).split('T')[0],
      }));
      resByDate.set(day.date, hostexLike);
    }

    const lastSyncedAt = new Date().toISOString();
    const rows = listingCal.calendar.map((day) =>
      mapHostexCalendarDay({
        day,
        listingId,
        reservationsForDate: resByDate.get(day.date) ?? [],
        lastSyncedAt,
      })
    );

    upsertAvailabilityBatch(rows);

    // Cleanup tage außerhalb der Range
    const deleted = deleteOldAvailability(listingId, startStr);

    logger.info(
      { slug, daysCount: rows.length, deletedOld: deleted, durationMs: Date.now() - startTime },
      'Hostex: calendar sync completed'
    );

    return { success: true, daysCount: rows.length };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: calendar sync failed');
    return {
      success: false,
      daysCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/hostex/sync-calendar.ts
git commit -m "feat: add Hostex sync-calendar job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: sync-properties Job

**Files:**
- Create: `src/jobs/hostex/sync-properties.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/hostex/sync-properties.ts`:

```ts
/**
 * Hostex Sync Properties
 *
 * Fetches the property record from Hostex, reads recently-synced reservations
 * and calendar sample from DB for the dynamic-fallback layer of the mapper,
 * and upserts the listing.
 */

import { getHostexClient } from '../../services/hostex-client.js';
import { getDatabase } from '../../db/index.js';
import { upsertListing } from '../../repositories/listings-repository.js';
import { mapHostexProperty } from '../../mappers/hostex/property-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';

export interface SyncPropertyResult {
  success: boolean;
  hostexProperty?: HostexProperty;
  error?: string;
}

export async function syncHostexProperty(property: PropertyConfig): Promise<SyncPropertyResult> {
  const slug = property.slug;
  const hostexId = property.hostexPropertyId!;

  try {
    logger.info({ slug, hostexId }, 'Hostex: starting property sync');

    const client = getHostexClient();
    const allProperties = await client.getProperties();
    const hostexProperty = allProperties.find((p) => String(p.id) === hostexId);
    if (!hostexProperty) {
      throw new Error(`Hostex property ${hostexId} not found in API response`);
    }

    // Load dynamic-fallback data from DB (whatever exists from previous syncs)
    const db = getDatabase();
    const recentReservationsRaw = db
      .prepare(
        `SELECT total_price, host_payout, currency
         FROM reservations
         WHERE listing_id = ?
         ORDER BY check_in DESC
         LIMIT 20`
      )
      .all(hostexId) as Array<{ total_price: number; host_payout: number; currency: string | null }>;

    // To get cleaning_fee fallback, we'd need rate details which we don't persist.
    // For now, recentReservations[] is empty array (cleaning_fee falls through to 0 or static).
    // base_price comes from calendar; cleaning_fee comes from static (acceptable trade-off).
    void recentReservationsRaw;
    const recentReservations: HostexReservation[] = [];

    const calendarSampleRaw = db
      .prepare(
        `SELECT price, min_nights, closed_to_arrival, closed_to_departure
         FROM availability
         WHERE listing_id = ?
         AND date(date) >= date('now')
         AND date(date) <= date('now', '+30 days')
         ORDER BY date ASC`
      )
      .all(hostexId) as Array<{
        price: number;
        min_nights: number;
        closed_to_arrival: number;
        closed_to_departure: number;
      }>;

    const calendarSample: HostexCalendarDay[] = calendarSampleRaw.map((r) => ({
      date: 'synthetic',
      price: r.price,
      inventory: 1,
      restrictions: {
        min_stay_on_arrival: r.min_nights,
        max_stay_on_arrival: 365,
        closed_on_arrival: r.closed_to_arrival === 1,
        closed_on_departure: r.closed_to_departure === 1,
      },
    }));

    const listing = mapHostexProperty({
      hostexProperty,
      propertyConfig: property,
      recentReservations,
      calendarSample,
    });

    upsertListing(listing);
    logger.info({ slug, hostexId }, 'Hostex: property sync completed');
    return { success: true, hostexProperty };
  } catch (error) {
    logger.error({ slug, error }, 'Hostex: property sync failed');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/hostex/sync-properties.ts
git commit -m "feat: add Hostex sync-properties job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: ETL-Dispatch in `etl-job.ts`

**Files:**
- Modify: `src/jobs/etl-job.ts`

Hostex-Sync läuft in der Reihenfolge: 1) properties-Bootstrap (mit den DB-Daten von letztem Lauf, beim allerersten Lauf evtl. Defaults), 2) reservations, 3) calendar.

- [ ] **Step 1: Imports ergänzen**

In `src/jobs/etl-job.ts` nach den bestehenden imports (Zeile 8-13) ergänzen:

```ts
import { syncHostexProperty } from './hostex/sync-properties.js';
import { syncHostexReservations } from './hostex/sync-reservations.js';
import { syncHostexCalendar } from './hostex/sync-calendar.js';
```

- [ ] **Step 2: Hostex-ETL-Funktion ergänzen**

Direkt vor `export async function runETLJobForProperty(...)` einfügen:

```ts
async function runHostexETL(property: PropertyConfig, force: boolean): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const slug = property.slug;

  logger.info({ propertySlug: slug, force }, `🚀 Starting Hostex ETL for ${property.name}`);

  // Step 1: bootstrap property listing
  const propertyResult = await syncHostexProperty(property);

  // Step 2: reservations (always run, FK on listings.id satisfied by Step 1)
  const reservationsResult = propertyResult.success
    ? await syncHostexReservations(property)
    : { success: false, inquiriesCount: 0, confirmedCount: 0, error: 'Skipped: property sync failed' };

  // Step 3: calendar
  const calendarResult = propertyResult.success && propertyResult.hostexProperty
    ? await syncHostexCalendar(property, propertyResult.hostexProperty)
    : { success: false, daysCount: 0, error: 'Skipped: property sync failed' };

  // Step 4 (optional re-mapping): if reservations & calendar succeeded, re-sync property
  // so the mapper sees the freshly-synced dynamic data for next-run accuracy.
  if (propertyResult.success && reservationsResult.success && calendarResult.success) {
    await syncHostexProperty(property);
  }

  const success =
    propertyResult.success && reservationsResult.success && calendarResult.success;

  const duration = Date.now() - startTime;
  logger.info(
    {
      propertySlug: slug,
      duration,
      success,
      daysCount: calendarResult.daysCount,
      inquiriesCount: reservationsResult.inquiriesCount,
      confirmedCount: reservationsResult.confirmedCount,
    },
    success
      ? `✅ Hostex ETL completed for ${property.name}`
      : `⚠️  Hostex ETL completed with errors for ${property.name}`
  );

  return {
    success,
    propertySlug: slug,
    propertyName: property.name,
    listing: { success: propertyResult.success, error: propertyResult.error },
    availability: {
      success: calendarResult.success,
      daysCount: calendarResult.daysCount,
      error: calendarResult.error,
    },
    inquiries: {
      success: reservationsResult.success,
      inquiriesCount: reservationsResult.inquiriesCount,
      confirmedCount: reservationsResult.confirmedCount,
      error: reservationsResult.error,
    },
    duration,
    timestamp,
  };
}
```

- [ ] **Step 3: Dispatch in `runETLJobForProperty`**

Finde den Beginn der Funktion (Zeile ~50):

```ts
export async function runETLJobForProperty(
  property: PropertyConfig,
  force: boolean = false
): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const { slug, guestyPropertyId, name } = property;
```

Direkt nach dem `const startTime = Date.now()` einfügen:

```ts
  // Dispatch by provider — Hostex has its own ETL pipeline
  if (property.provider === 'hostex') {
    return runHostexETL(property, force);
  }
```

- [ ] **Step 4: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/etl-job.ts
git commit -m "feat: dispatch ETL by provider for Hostex support

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Manuelles Test-Sync-Script

**Files:**
- Create: `src/scripts/test-hostex-sync.ts`

- [ ] **Step 1: Script anlegen**

Datei `src/scripts/test-hostex-sync.ts`:

```ts
/**
 * Manual Hostex Sync Test
 *
 * Usage:
 *   npx tsx src/scripts/test-hostex-sync.ts <slug>
 *
 * Runs the full Hostex ETL pipeline for one configured property,
 * shows the result, and prints a quick sanity-check of the DB rows.
 */

import { getPropertyBySlug } from '../config/properties.js';
import { runETLJobForProperty } from '../jobs/etl-job.js';
import { getDatabase, initDatabase } from '../db/index.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: test-hostex-sync.ts <slug>');
    process.exit(1);
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found in properties.json`);
    process.exit(1);
  }
  if (property.provider !== 'hostex') {
    console.error(`Property '${slug}' is not a Hostex property (provider=${property.provider})`);
    process.exit(1);
  }

  initDatabase();
  const result = await runETLJobForProperty(property, true);
  console.log('\n=== ETL Result ===');
  console.log(JSON.stringify(result, null, 2));

  const db = getDatabase();
  const listing = db
    .prepare('SELECT * FROM listings WHERE id = ?')
    .get(property.hostexPropertyId);
  const reservations = db
    .prepare('SELECT COUNT(*) AS n FROM reservations WHERE listing_id = ?')
    .get(property.hostexPropertyId);
  const inquiries = db
    .prepare('SELECT COUNT(*) AS n FROM inquiries WHERE listing_id = ?')
    .get(property.hostexPropertyId);
  const availability = db
    .prepare('SELECT COUNT(*) AS n FROM availability WHERE listing_id = ?')
    .get(property.hostexPropertyId);

  console.log('\n=== DB Sanity Check ===');
  console.log('listing:', listing ? '✓' : '✗');
  console.log('reservations count:', reservations);
  console.log('inquiries count:', inquiries);
  console.log('availability count:', availability);
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/test-hostex-sync.ts
git commit -m "feat: add manual Hostex sync test script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Final Build/Lint/Tests + Smoke-Test

**Files:** keine Änderungen, nur Verifikation.

- [ ] **Step 1: Volles Build**

Run: `npm run build`
Expected: Kein Error, `dist/` ist aktuell.

- [ ] **Step 2: Volle Test-Suite**

Run: `npm test -- --run`
Expected: alle bisherigen 55 + neue Hostex-Tests (Reservation 14 + Calendar 6 + Property 20 = 40) bestehen → 95 passing.

- [ ] **Step 3: Properties.json laden ohne Hostex-Token-Fehler**

Aktuelle `data/properties.json` enthält nur Guesty-Properties und kein `provider`-Feld. Soll weiter laden ohne Hostex-Token zu fordern.

Run: `npx tsx -e "import('./src/config/properties.js').then(m => console.log(m.getAllProperties().length, 'properties loaded'))"`
Expected: `2 properties loaded`

- [ ] **Step 4: Hostex-Client-Lazy-Init verifizieren**

`getHostexClient()` wirft nur dann, wenn explizit gerufen. Da kein Sync-Aufruf für Hostex-Properties existiert (noch keine in properties.json), darf der App-Boot ohne `HOSTEX_ACCESS_TOKEN` durchlaufen.

Run (ohne `HOSTEX_ACCESS_TOKEN`): `unset HOSTEX_ACCESS_TOKEN && npx tsx -e "import('./src/db/index.js').then(m => { m.initDatabase(); console.log('boot ok'); })"`
Expected: `boot ok` — kein Token-Fehler.

---

### Task 17: CLAUDE.md Doku + Deployment-Anweisung

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Neue Sektion ergänzen**

In `CLAUDE.md` nach der Sektion „Guest Fingerprint (Migration 012)" (vor „Authentication") einfügen:

```markdown
### Hostex Integration

Zweiter Booking-Provider neben Guesty. Parallel-Modul-Architektur, ETL-Dispatch nach `provider`-Feld in `properties.json`.
- **Provider-Discriminator**: jede Property hat `provider: 'guesty' | 'hostex'` (Default `guesty`)
- **Hostex-Properties** brauchen `hostexPropertyId` (String) und `static`-Block in `properties.json` (mit Pflichtfeld `accommodates`)
- **API-Client**: `src/services/hostex-client.ts` (Header-Token via `HOSTEX_ACCESS_TOKEN` env-var, Bottleneck-Rate-Limit, Exponential-Backoff)
- **Mapper**: `src/mappers/hostex/{property,reservation,calendar}-mapper.ts` (alle pure functions, vollständig getestet)
- **ETL**: `src/jobs/hostex/{sync-properties,sync-reservations,sync-calendar}.ts` (Reihenfolge: properties → reservations → calendar → re-property)
- **Status-Routing**: alle Reservations → `inquiries` (BI-Pool), aktive (`accepted`/`wait_pay`) zusätzlich → `reservations`
- **Manueller Test**: `npx tsx src/scripts/test-hostex-sync.ts <slug>`
- **Spec**: `docs/superpowers/specs/2026-05-13-hostex-integration-design.md`

**Deployment-Reihenfolge (Production):**
1. `HOSTEX_ACCESS_TOKEN=...` in `/opt/guesty-calendar-app/.env` ergänzen
2. `data/properties.json` erweitern um 3 Hostex-Properties mit `provider: 'hostex'` + `static`-Block
3. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
4. `pm2 logs guesty-calendar --lines 20` → keine Zod-Validation-Errors
5. Manueller Test pro Property: `npx tsx src/scripts/test-hostex-sync.ts <slug>`
6. SQL-Stichprobe für jede Property: `sqlite3 data/calendar.db "SELECT id, title, base_price FROM listings WHERE id IN ('12659676', '12659677', '12659678')"`
7. 24h PM2-Logs auf WARN/ERROR beobachten — besonders unknown-status Warnings

**Rollback**: 3 Hostex-Property-Einträge aus `properties.json` entfernen, Server-Restart. DB-Rows können stehenbleiben oder via SQL gelöscht werden.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Hostex integration in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done-Definition

- [ ] Migrations: keine notwendig (Hostex nutzt bestehende Tabellen)
- [ ] `hostex-client.ts` mit 3 Methoden, Bottleneck-Rate-Limit, Retry-Logic
- [ ] 3 Mapper (property, reservation, calendar), 40 grüne Tests
- [ ] 3 Sync-Jobs unter `src/jobs/hostex/`
- [ ] ETL-Dispatch in `etl-job.ts` nach `provider`
- [ ] Test-Script `test-hostex-sync.ts`
- [ ] Test-Fixtures aus Live-API
- [ ] `properties.json` Schema erweitert
- [ ] Build + Lint + Tests grün
- [ ] CLAUDE.md aktualisiert
- [ ] Bestehende Guesty-Tests + 55 Fingerprint-Tests bestehen weiter

## Pre-Deploy-Checkliste

Nach Merge auf `main` (siehe CLAUDE.md-Sektion oben). Property-Konfiguration ist manueller User-Schritt — die `static`-Werte (accommodates, bedrooms, taxes etc.) müssen vom User korrekt eingetragen werden, das kann nicht automatisiert werden.
