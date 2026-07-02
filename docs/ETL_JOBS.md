# ETL Jobs Documentation

This document describes the Extract-Transform-Load (ETL) jobs that populate the SQLite cache with data from the Guesty API.

## Overview

The ETL system fetches listing details and availability data from Guesty, normalizes it, and stores it in the local SQLite database. This enables fast responses for the website without hitting the Guesty API on every request.

## Architecture

```
┌─────────────────────┐
│   Guesty API        │
│   (External)        │
└──────────┬──────────┘
           │
           │ HTTP Fetch
           ▼
┌─────────────────────┐
│   ETL Jobs          │
│   - Sync Listing    │
│   - Sync Avail.     │
└──────────┬──────────┘
           │
           │ Normalize & Map
           ▼
┌─────────────────────┐
│   SQLite Cache      │
│   - listings        │
│   - availability    │
└─────────────────────┘
```

## Components

### 1. Guesty API Client (`src/services/guesty-client.ts`)

Handles all communication with the Guesty Open API:
- Authenticated requests with Bearer token
- Error handling and retries
- Logging and performance tracking

**Methods:**
- `getListing(id)` - Fetch listing details
- `getCalendar(id, start, end)` - Fetch availability for date range
- `get12MonthsCalendar(id)` - Fetch 12 months starting today
- `healthCheck()` - Verify API connectivity

### 2. Data Mappers (`src/mappers/`)

Transform Guesty API responses to internal data models:
- `listing-mapper.ts` - Map listing fields and taxes
- `availability-mapper.ts` - Map calendar days with status logic

**Key Transforms:**
- Status determination (handles multi-unit properties)
- Block type extraction (reservation, owner, maintenance)
- Tax structure simplification
- Active listing determination (`active && listed`)

### 3. Database Repositories (`src/repositories/`)

Perform database operations with error handling:
- `listings-repository.ts` - CRUD for listings
- `availability-repository.ts` - Batch operations for availability

**Features:**
- Upsert (insert or update) operations
- Batch transactions for performance
- Cache freshness checks
- Date range queries

### 4. Sync Jobs (`src/jobs/`)

Execute the ETL process:
- `sync-listing.ts` - Sync listing data
- `sync-availability.ts` - Sync 12 months of availability
- `etl-job.ts` - Orchestrate complete sync
- `scheduler.ts` - Schedule recurring jobs

## Jobs

### Sync Listing Job

**Purpose:** Fetch and cache property details (pricing, taxes, capacity, terms)

**Frequency:** Every 24 hours (configurable via `CACHE_LISTING_TTL`)

**Data:**
- Title, capacity, bedrooms/bathrooms
- Base price, weekend price, cleaning fee, extra guest fee
- Discounts (weekly, monthly)
- Taxes (with rules and quantifiers)
- Terms (min/max nights, check-in/out times)

**Cache Logic:**
- Checks `last_synced_at` against TTL
- Skips if cache is fresh (unless forced)
- Upserts on conflict (by listing ID)

**Error Handling:**
- Logs errors but doesn't fail entire ETL
- Returns success/error status
- Continues with availability sync even if listing fails

### Sync Availability Job

**Purpose:** Fetch and cache 12 months of daily availability

**Frequency:** Every 1 hour with jitter (configurable via `CACHE_AVAILABILITY_TTL`)

**Data (per day):**
- Date, status (available/blocked/booked)
- Nightly price
- Minimum stay requirement
- Restrictions (CTA, CTD)
- Block information (type, reference)

**Cache Logic:**
- Checks date range coverage (needs ≥11 months future coverage)
- Fetches full 12 months from Guesty
- Deletes old (past) records
- Batch upserts new data (transaction for performance)

**Chunked Mode:**
- Alternative: fetch in 3-month chunks
- Useful for rate limiting or large date ranges
- Partial success support (continues on chunk failure)

**Error Handling:**
- Graceful handling of missing/partial data
- Logs errors per chunk (if chunked mode)
- Returns day count even on partial success

### Complete ETL Job

**Purpose:** Orchestrate listing + availability sync (Guesty properties)

**Execution:**
1. Sync listing (Step 1/2)
2. Sync availability (Step 2/2)
3. Return combined result

**Success Criteria:**
- Both steps must succeed for overall success
- Either step can be skipped if cache is fresh

---

### Hostex ETL Pipeline (`runHostexETL`)

**Purpose:** Full sync for Hostex-provider properties, including guest conversations and AI reply drafts.

**Execution order:**
1. **Sync property listing** — upsert `listings` from static config
2. **Sync reservations** — fetch bookings from Hostex API; skipped if Step 1 failed
3. **Sync messages** — fetch all Hostex conversations and persist to `message_threads` + `messages` (**non-fatal**)
4. **Generate AI drafts** — for threads needing a reply, produce Claude drafts (**non-fatal**)
5. **Sync calendar** — fetch availability; skipped if Step 1 failed
6. **Re-sync property** (optional) — re-runs Step 1 if 1+2+5 all succeeded, to pick up freshly-synced state

Steps 3 and 4 run in separate `try/catch` blocks: an error in either one is logged but does not fail the overall ETL result or block the calendar sync.

**Message sync rules:**
- Fetches conversations account-wide (`limit=100`); attributes to property by `property_title` match (bookings) or detail `activities[].property.id` (inquiries with empty `property_title`)
- `syncHostexMessagesForProperty` accepts an optional `detailCache` (Map). The scheduled ETL does not pass one (each property runs independently). The "Jetzt syncen" UI button path creates a shared Map across all property passes so each conversation detail is fetched at most once per manual run
- Only `display_type='Text'` messages are persisted; system cards (`Box`, `ReservationAlteration`) are discarded

**Draft generation rules:**
- Requires `hostexPropertyId` + `vaultNote` on the property config, plus `VAULT_PATH` and `ANTHROPIC_API_KEY` in environment
- Only threads whose last guest message is within `DRAFT_MAX_AGE_HOURS` (default 72 h) are eligible
- Only threads with no existing `pending` draft and whose last direction is `inbound`
- Capped at `DRAFT_GEN_CAP` (default 10) drafts per property per run
- Idempotent: re-running the ETL skips threads that already have a pending draft

**Success Criteria:**
- Steps 1, 2, and 5 must all succeed for overall `success: true`
- Steps 3 and 4 failures are logged (`error` level) but do not affect the success flag

## Scheduling

### Automatic Scheduling

The scheduler starts automatically when the server starts:
- Uses `CACHE_AVAILABILITY_TTL` as the interval (default: 1 hour)
- Adds ±5% random jitter to prevent thundering herd
- Runs immediately on startup
- Then runs on interval with jitter

**Configuration:**
```env
CACHE_AVAILABILITY_TTL=1  # Run every 1 hour (with jitter)
```

**Jitter:**
- Random ±5% variance added to each scheduled run
- Prevents multiple instances from syncing simultaneously
- Example: 1h interval becomes 57-63 minutes

**Lifecycle:**
- Starts: When server starts
- Stops: On graceful shutdown (SIGTERM/SIGINT)

### Manual Triggers

Multiple ways to manually trigger sync:

#### 1. CLI Script

```bash
# Normal sync (respects cache TTL)
npm run sync

# Force sync (ignores cache freshness)
npm run sync:force
```

#### 2. HTTP Endpoints

**Sync All (Listing + Availability)**
```bash
POST /sync/all
POST /sync/all?force=true
```

**Sync Listing Only**
```bash
POST /sync/listing
POST /sync/listing?force=true
```

**Sync Availability Only**
```bash
POST /sync/availability
POST /sync/availability?force=true
```

**Check Status**
```bash
GET /sync/status
```

## Cache Invalidation Strategy

### Listings Table
- **TTL:** 24 hours (configurable)
- **Trigger:** Scheduled job or manual sync
- **Logic:** Check `last_synced_at`, skip if fresh

### Availability Table
- **TTL:** 1 hour (configurable)
- **Trigger:** Scheduled job with jitter or manual sync
- **Logic:** Check date range coverage + freshness
- **Cleanup:** Deletes past dates on each sync

### Force Flag
- Bypasses cache freshness checks
- Forces immediate re-fetch from API
- Useful for:
  - Testing
  - After known Guesty updates
  - Admin operations

## Error Handling

### Partial Data Support

The ETL system handles failures gracefully:

1. **Listing Failure:**
   - Logs error
   - Returns error status
   - **Continues** with availability sync

2. **Availability Failure:**
   - Logs error
   - Returns error status
   - Partial data may be saved (if chunked mode)

3. **API Errors:**
   - Retries on 5xx errors (configurable)
   - Logs detailed error info
   - Returns structured error response

### Missing Data Handling

- **Missing optional fields:** Uses defaults
- **Missing required fields:** Logs error, skips record
- **Empty calendar response:** Logs warning, returns error
- **Malformed data:** Validation errors logged

## Monitoring

### Logs

All operations are logged with:
- Start/end timestamps
- Duration
- Record counts (listing upserted, availability rows upserted)
- Success/error status
- Skipped/errors/retries per run
- Jitter applied to next scheduled run
- Detailed error messages

**Log Levels:**
- `info` - Normal operations (includes hourly completion logs)
- `warn` - Non-critical issues (e.g., skipped sync)
- `error` - Failures
- `debug` - Detailed execution info

**Example Log Output:**
```
⏰ Scheduled ETL job triggered
🚀 Starting ETL job (propertyId: xxx, force: false)
Step 1/2: Syncing listing data...
Listing cache is fresh, skipping sync
Step 2/2: Syncing availability data...
Availability cache is fresh, skipping sync
✅ Scheduled ETL job completed (jobCount: 5, listingSkipped: true, availabilitySkipped: true, durationMs: 2)
⏱️  Next scheduled run (nextRun: 2025-10-02T01:15:23.456Z, intervalMs: 3654000, jitterApplied: true)
```

### Metrics (from logs)

- Sync duration
- Days synced
- Cache hit rate (skipped syncs)
- Error frequency

### Health Checks

**Database Status:**
```bash
GET /health/detailed
```

Returns:
- Database connection status
- Table initialization status
- Record counts
- Database size

**Scheduler Status:**
```bash
GET /sync/status
```

Returns:
- Scheduler running status
- Last run timestamp
- Next run timestamp
- Total job count
- Interval configuration

## Performance

### Optimization Strategies

1. **Batch Operations:**
   - Availability uses batch upsert with transactions
   - Processes 365+ days in single transaction

2. **Indexes:**
   - `(listing_id, date)` for availability queries
   - `last_synced_at` for cache checks

3. **Date Range Queries:**
   - Uses simple string comparison (YYYY-MM-DD)
   - No timezone conversion overhead

4. **Chunked Fetching:**
   - Optional 3-month chunks for large datasets
   - Reduces memory usage
   - Enables partial success

### Typical Performance

- **Listing sync:** ~500-1000ms (API call + DB write)
- **Availability sync:** ~2-5 seconds (12 months = ~365 days)
- **Complete ETL:** ~3-6 seconds total

## Troubleshooting

### Sync Not Running

Check scheduler status:
```bash
GET /sync/status
```

Check logs for errors:
```bash
# Look for scheduler startup messages
grep "Starting job scheduler" logs/
```

### Stale Data

Force a fresh sync:
```bash
npm run sync:force
# OR
curl -X POST http://localhost:3000/sync/all?force=true
```

### API Errors

Check Guesty API credentials:
```env
GUESTY_API_KEY=your_key
GUESTY_PROPERTY_ID=your_id
```

Test connectivity:
```bash
GET /health/detailed
```

### Partial Availability Data

Use chunked mode for more resilient fetching:
```typescript
import { syncAvailabilityChunked } from './jobs/sync-availability.js';
await syncAvailabilityChunked(listingId, 3); // 3-month chunks
```

## Future Enhancements

- [ ] Incremental updates (only changed dates)
- [ ] Webhook support for real-time updates
- [ ] Multi-listing support
- [ ] Rate limiting and backoff strategies
- [ ] Retry logic for transient failures
- [ ] Metrics dashboard
- [ ] Alert system for failed syncs