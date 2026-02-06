# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js/TypeScript service that provides Airbnb-style booking calendars for multiple Guesty properties. The service caches Guesty API data in SQLite and serves it through a public API with a vanilla JavaScript frontend. Properties are configured via `data/properties.json` and each gets its own URL namespace (`/p/:slug/...`).

## Development Commands

```bash
npm run dev              # Development with hot reload (tsx watch)
npm run build            # Compile TypeScript to dist/
npm start               # Run production build from dist/
npm run lint            # ESLint on src/**/*.ts
npm test               # Run tests with Vitest

# Data sync
npm run sync            # Sync all properties (respects cache)
npm run sync:force      # Force sync all properties
npx tsx src/scripts/sync-property.ts <slug>  # Sync single property (e.g., farmhouse, u19)

# Testing scripts
npx tsx src/scripts/test-email.ts [slug]     # Send test weekly email (optional: for specific property)
npx tsx src/scripts/test-document.ts <reservationId> <quote|invoice>
npx tsx src/scripts/set-document-sequence.ts [year] [lastNumber]
npx tsx src/scripts/list-properties.ts       # List all Guesty properties
```

### Access Points
- Property calendar: `http://localhost:3000/p/:slug` (e.g., `/p/farmhouse`, `/p/u19`)
- Property API: `/p/:slug/listing`, `/p/:slug/availability`, `/p/:slug/quote`
- Admin dashboard: `/admin` (property stats, bookings, analytics, documents)
- Admin system: `/admin/system` (health, sync, DB viewer, ETL, user management)
- Legacy routes: `/listing`, `/availability`, `/quote` (use default property)
- Auth: `/auth/login`, Health: `/health`, `/health/detailed`

## Multi-Property Configuration

Properties are defined in `data/properties.json` (validated with Zod on startup):
```json
{
  "properties": [
    {
      "slug": "farmhouse",
      "guestyPropertyId": "686d1e927ae7af00234115ad",
      "name": "Farmhouse Prasser",
      "timezone": "Europe/Berlin",
      "currency": "EUR",
      "bookingRecipientEmail": "booking@farmhouse-prasser.de",
      "bookingSenderName": "Farmhouse Prasser",
      "weeklyReport": { "enabled": true, "recipients": ["..."], "day": 1, "hour": 6 },
      "ga4": { "enabled": true, "propertyId": "513788097", "keyFilePath": "...", "syncHour": 3 }
    }
  ]
}
```

**Key files:**
- `data/properties.json` - Central property configuration
- `src/config/properties.ts` - Loader: `getPropertyBySlug()`, `getAllProperties()`, `getDefaultProperty()`
- `src/routes/property-routes.ts` - Property-scoped API routes (`/p/:slug/...`)

**Important patterns:**
- `config.guestyPropertyId` is **optional** in `.env` (overridden by `properties.json`)
- Always use fallback: `config.guestyPropertyId || getDefaultProperty()?.guestyPropertyId`
- `ga4` field is optional per property (defaults to `{ enabled: false }`)
- Legacy routes (without `/p/:slug`) use the default (first) property
- `req.property` available after `resolveProperty` middleware

### Adding a New Property
1. Find the Guesty listing ID: `npx tsx src/scripts/list-properties.ts`
2. Add property config to `data/properties.json`
3. Sync: `npx tsx src/scripts/sync-property.ts <slug>`
4. Verify in admin dashboard (property selector)

## Architecture Overview

### Data Flow
1. **Properties Config** (`data/properties.json`) defines all managed properties
2. **ETL Jobs** (`src/jobs/`) fetch data from Guesty API for each property on startup and hourly
3. **Guesty Client** (`src/services/guesty-client.ts`) handles OAuth + rate-limited requests (Bottleneck)
4. **Repositories** (`src/repositories/`) handle SQLite operations, keyed by `listing_id`
5. **Routes** (`src/routes/`) serve API endpoints per property
6. **Frontend** (`public/`) vanilla JS calendar with property context injection

### ETL & Cache
- `runETLJobForProperty(property, force)` - Sync single property
- `runETLJob(force)` - Sync all properties sequentially
- Listings: 24h TTL | Availability: configurable via `CACHE_AVAILABILITY_TTL` (default 30min) | Quotes: 60min TTL
- Daily forced sync at 2 AM for all properties (24 months of data)
- Scheduler tracks per-property state: `propertyWeeklyEmailSent: Map<string, Date>`

### Rate Limiting
- 10 req/sec, 10 concurrent (below Guesty's 15/15 limits)
- Exponential backoff with jitter for 429 responses
- OAuth retry: up to 5 attempts with backoff

### Admin Dashboard
- **`/admin`** - Property Dashboard: stats, conversion rate, analytics (if GA4 enabled), bookings, documents
- **`/admin/system`** - System: health, sync, DB viewer, ETL scheduler, user management
- Property selector on both pages; analytics auto-hidden for properties without GA4

### Weekly Email Reports
Per-property config in `properties.json`: `weeklyReport: { enabled, recipients, day (0-6), hour (0-23) }`

- Scheduler checks each property's schedule hourly (timezone-aware via `date-fns-tz`)
- `sendWeeklySummaryEmailForProperty(property)` - generates and sends per-property email
- Includes: all-time stats, current year, occupancy, conversion rate, GA4 analytics (if enabled), top 5 bookings
- Revenue uses `host_payout` (net after platform fees)
- Sent via Resend API; sender name configured via `EMAIL_FROM_NAME` env var

### Google Analytics 4
Optional per property. Configured in `properties.json` `ga4` field (or omit for disabled).
- Syncs daily at configured hour via `src/jobs/sync-analytics.ts`
- Admin dashboard shows/hides analytics based on `ga4Enabled` flag per property
- Setup: Create GCP service account → grant GA4 Viewer → add JSON key to `data/ga4-service-account.json`

### Document Generation (Quotes & Invoices)
- PDF generation: Puppeteer + Handlebars templates (`data/templates/angebot.html`, `rechnung.html`)
- Quotes: `A-YYYY-NNNN`, Invoices: `YYYY-NNNN` (independent counters per year)
- **Document numbering is SHARED across all properties** (one global sequence per type per year)
- Document numbers are **permanently stable** once created (never change, even on refresh)
- Refresh button (↻) fetches fresh Guesty data but preserves the document number
- Company names (GmbH, AG, UG, Ltd, etc.) in guest firstName auto-detected

### Authentication
- Google OAuth 2.0 via Passport.js (`src/config/auth.ts`)
- Email whitelist: `ADMIN_ALLOWED_EMAILS` env var
- Session-based with secure cookies (24h lifetime)

### Error Handling
Custom error classes in `src/utils/errors.ts`: `ConfigError`, `DatabaseError`, `ExternalApiError`, `ValidationError`, `NotFoundError`, `CacheMissError`. All extend `AppError` with structured Pino logging.

## Key Patterns

- **Database**: `better-sqlite3` sync API, `listing_id` as key (multi-property ready without migrations)
- **Dates**: ISO 8601 strings, property timezone for availability, UTC for `last_synced_at`
- **Logging**: Pino structured logging, include `propertySlug` for multi-property tracing
- **Testing**: Vitest, mock DB and Guesty API responses
- **Optional config fallback**:
```typescript
const defaultProperty = getDefaultProperty();
const propertyId = config.guestyPropertyId || defaultProperty?.guestyPropertyId;
if (!propertyId) throw new NotFoundError('No property configured');
```

## Important Files

### Configuration
- `.env` / `.env.example` - Environment variables (secrets, API keys)
- `data/properties.json` - Multi-property config (slug, Guesty ID, email, weekly report, GA4)
- `src/config/index.ts` - Zod-validated config object
- `src/config/properties.ts` - Property config loader with caching

### Services & Jobs
- `src/services/guesty-client.ts` - OAuth + rate-limited Guesty API client
- `src/services/pricing-calculator.ts` - Local quote computation
- `src/jobs/scheduler.ts` - ETL scheduling with jitter, per-property state
- `src/jobs/etl-job.ts` - Listing + availability sync orchestration
- `src/jobs/weekly-email.ts` - Per-property weekly email with `sendWeeklySummaryEmailForProperty()`

### Routes
- `src/routes/property-routes.ts` - `/p/:slug/*` routes with `resolveProperty` middleware
- `src/routes/admin.ts` - `/admin` dashboard + `/admin/system`
- `src/routes/listing.ts`, `availability.ts`, `quote.ts` - Legacy routes (default property)

### Frontend
- `public/calendar.js` - Calendar with property context (`window.__PROPERTY_SLUG__`, `__PROPERTY_NAME__`, `__BOOKING_EMAIL__`)
- `public/calendar.css` - Mobile-first responsive design

## Environment Variables

**Note:** Per-property settings (booking email, timezone, weekly report, GA4) are in `data/properties.json`. The `.env` variables are legacy fallbacks.

Required:
- `GUESTY_CLIENT_ID`, `GUESTY_CLIENT_SECRET` - Guesty OAuth credentials
- `BASE_URL` - Public URL (e.g., `https://guesty.remoterepublic.com`)
- `SESSION_SECRET` - Random 32+ char string for sessions
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - Google OAuth for admin
- `ADMIN_ALLOWED_EMAILS` - Comma-separated email whitelist
- `RESEND_API_KEY` - Resend email service API key
- `EMAIL_FROM_ADDRESS` - Sender email (verified domain)
- `EMAIL_FROM_NAME` - Sender display name (e.g., "Remote Republic Booking")

Optional:
- `GUESTY_PROPERTY_ID` - Legacy single-property fallback
- `PORT` (default: 3000), `DATABASE_PATH` (default: ./data/calendar.db)
- `CACHE_AVAILABILITY_TTL` - Minutes between ETL runs (default: 60)
- `LOG_LEVEL` (default: info), `LOG_PRETTY` (default: false)

## Guesty API Quirks

- OAuth tokens: 24h validity, cached until 5min before expiry
- Calendar endpoint: unwrap `data.days` from response
- Rate limits: 15 req/sec, 120 req/min, 5000 req/hour
- `listings.nickname` may be null → fallback to `title`
- Tax codes: `AF` = accommodation fare, `CF`/`CLEANING` = cleaning fee
- **Quirk**: `limit=100` returns all reservations, but `limit=1000` returns fewer

## Git & Deployment

### Commit Conventions
Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `perf:`

### Repository Structure
```
main (default branch)
├── data/properties.json    # Multi-property config (commit this)
├── data/templates/         # PDF templates (commit these)
├── src/                    # TypeScript source
├── public/                 # Static frontend
├── .env                    # Secrets (NEVER commit)
└── data/calendar.db        # SQLite DB (ignored)
```

### Production Server
- **Host**: `deploy@guesty.remoterepublic.com`
- **Path**: `/opt/guesty-calendar-app`
- **Process**: PM2 (`guesty-calendar`), requires nvm sourcing for CLI commands
- **Proxy**: Caddy with auto-SSL on port 3005
- **Deploy**: `git pull && npm install && npm run build && pm2 restart guesty-calendar`
- **Logs**: `pm2 logs guesty-calendar --lines 50`
- **Health**: `curl https://guesty.remoterepublic.com/health`

### Production Checklist
- [ ] `data/properties.json` present with all properties
- [ ] All properties synced (`sync-property.ts <slug>` for each)
- [ ] `.env` configured (Guesty API, OAuth, Resend, session secret)
- [ ] Google OAuth callback URL set for production domain
- [ ] Health check responding
- [ ] Weekly report recipients configured per property
- [ ] GA4 service account configured (if applicable)
