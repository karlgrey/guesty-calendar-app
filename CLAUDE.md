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
- **"Aktuell belegt" block**: an always-visible block above the bookings list shows currently
  in-house stays (`getCurrentReservations`: `check_in ≤ today < check_out`) in BOTH the Next/Last
  12-Months views (else "Aktuell nicht belegt"), with the same quote/invoice actions. In-house
  stays also count in the `future`-period `getDashboardStats` (revenue query uses
  `check_out > today`). Spec: `docs/superpowers/specs/2026-06-10-current-booking-block-design.md`.

### Weekly Email Reports
Per-property config in `properties.json`: `weeklyReport: { enabled, recipients, day (0-6), hour (0-23) }`

- Scheduler checks each property's schedule hourly (timezone-aware via `date-fns-tz`)
- `sendWeeklySummaryEmailForProperty(property)` - generates and sends per-property email
- Includes: all-time stats, current year, occupancy, conversion rate, GA4 analytics (if enabled), top 5 bookings
- Revenue uses `host_payout` (net after platform fees)
- Sent via Resend API; sender name configured via `EMAIL_FROM_NAME` env var

### Portfolio BI Report (alle Properties)

Eine wöchentliche, konsolidierte Mail über alle Properties — ergänzt die per-Property-Weekly-Reports.
Konfiguration als **Top-Level-Block** `biReport` in `data/properties.json` (Geschwister von `properties`):
`{ enabled, recipients[], day (0-6), hour (0-23), timezone, forecastHorizonMonths }`.

- Scheduler prüft stündlich (timezone-aware), sendet einmal pro Slot (`shouldSendBiReport()`).
- Inhalt: Portfolio-Summenband · 6-Wochen-Belegungskalender (belegt/frei/Turnover) · nächste 5
  Anreisen & Turnovers · KPI-Tabelle pro Property (Belegung 6Wo/30Tg, Umsatz YTD/Monat/Δ, Buchungen, ADR) ·
  6-Monats-Forecast (OTB + portfolioweit gepoolter Pickup, pro Property mit „dünne Datenbasis"-Flag).
- Forecast: `src/services/forecast.ts` (Lead-Time-Kurve aus `reservations.reserved_at`), Kalender:
  `src/services/bi-calendar.ts`, Orchestrierung: `src/jobs/bi-email.ts`, Renderer: `src/services/bi-email-templates.ts`.
- Manueller Test: `npx tsx src/scripts/test-bi-email.ts` (respektiert `DEV_EMAIL_OVERRIDE`).
- **Deploy:** seit 2026-06-08 ist die frühere Prod-`properties.json`-Divergenz aufgelöst (alle
  echten Empfänger sind committet, prod-Arbeitskopie sauber) → Deploy ist wieder plain
  `git pull && npm run build && pm2 restart`, **kein** `git stash`/`pop` mehr nötig. Empfänger
  künftig im Repo ändern, nicht live auf prod.
- Spec: `docs/superpowers/specs/2026-06-02-portfolio-bi-email-design.md`

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
- **Airbnb invoices = what the GUEST pays**, NOT the host payout. In `document-service.ts`
  `extractPricingFromReservation`, the `isAirbnb` branch sets
  `discountTotal = fareAccommodationAdjusted − fareAccommodation` (the real guest discount,
  e.g. length-of-stay) so the **Airbnb host channel fee (commission) is excluded**, while
  real discounts stay in. `subtotal = fareAccommodationAdjusted + cleaning + extras`,
  `total = subtotal + taxes`. (Do NOT use `subTotalPrice`/`hostPayout` for Airbnb — those are
  net of commission.) Verified: reservation `6a2720bb` (UNvia/Janos Udvary) → 332.98 €.
  Regression history in `docs/superpowers/specs/2026-06-05-…` family; covered by
  `document-service.airbnb-pricing.test.ts`.

### Owner Blocks & Sellable Occupancy

Owner/host-blocked (non-rentable) days are handled consistently via the canonical marker
**`availability.status = 'blocked'`** (provider-agnostic). Spec:
`docs/superpowers/specs/2026-06-04-owner-blocks-design.md`.
- **Classification:** Guesty `blocks.o/m` → blocked; Hostex `inventory=0` → blocked; Florence
  Airbnb-iCal `SUMMARY:Airbnb (Not available)` → blocked/`owner` (in
  `mappers/airbnb-mail/availability-mapper.ts`). Reservations (`Reserved`) stay `booked`.
- **Sellable occupancy:** `getOccupancyRate`/`getOccupancyBreakdown` = `booked / (total − blocked)`
  (blocked days excluded from the rentable base; `getDashboardStats` aligned). Used by BI mail,
  weekly mail, admin.
- **Google Calendar:** `sync-google-calendar.ts` pushes blocked spans as all-day events labelled by
  reason/source via `services/google-calendar-blocks.ts` `blockLabel(blockType, provider)`
  (`Owner-Block`/`Manuell blockiert`/`Wartung`/`Blockiert (Hostex|Airbnb)`, no emoji). Cleanup keys
  on `extendedProperties.private.kind='owner-block'`; **`listEvents` MUST request `fields=…
  extendedProperties`** or the default response omits it. Spans split on `block_type` change.
- **BI mail:** owner-blocked days render the same red as booked (not available); a `Block-Tg` KPI
  column shows blocked days per property. (`getReservationsByPeriod` is intentionally NOT changed —
  it stays "future = real arrivals" for BI/weekly/calendar.)

### Guest Fingerprint (Migration 012)

Lokal berechneter Fingerprint für Repeat-Customer-Analyse — keine zusätzlichen Guesty-API-Calls.
Felder: `reservations.internal_guest_id` (Slug), `reservations.guest_company` (Klartext-Firma, NULL bei Privatpersonen).
- Algorithmus: `src/utils/guest-fingerprint.ts` (pure function, vollständig getestet in `guest-fingerprint.test.ts`)
- Schreibt sich bei jedem ETL-Sync automatisch ins Mapping (`reservation-mapper.ts`)
- Einmaliges Backfill: `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
- Spec: `docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md`

**Pre-Backfill-Check (wichtig):** Bei stale-Sync würden alte Namen gefingerprintet. Daher
vor dem Backfill auf Production einen Force-Sync laufen lassen:
`npx tsx src/scripts/sync-property.ts farmhouse` und `... u19`.

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

### Airbnb-Mail Integration (Migration 013)

Dritter Booking-Provider für Properties, die nur über Airbnb laufen. Daten kommen aus:
- **IMAP-Inbox** (z.B. dedizierter Bot-Account `airbnb-bot@…`) — Buchungs-Mails
- **iCal-URL** (Airbnb Listing → Calendar Settings → Export) — Verfügbarkeit

**Property-Discriminator**: `provider: 'airbnb-mail'` in `properties.json`, plus `airbnbListingId`, `airbnbIcalUrl`, `airbnbMailLabel` (Gmail-Label, optional), `static`-Block.

**Mail-Typen**: confirmed, inquiry, cancellation, modification. Subject-Patterns sind initial Schätzungen — werden nach Live-Daten kalibriert.

**Storage**:
- `reservations` / `inquiries` / `availability`: bestehende Tabellen, `source='airbnb'`
- `airbnb_mail_archive`: rohe Mail-Bodies + Parse-Status, 90 Tage Retention
- `airbnb_mail_state`: per-Property last-IMAP-UID für inkrementellen Poll

**Scripts**:
- `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>` — manueller ETL-Test
- `npx tsx src/scripts/reparse-airbnb-mail.ts <message_id> [--force]` — einzelne Mail neu parsen
- `npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors [--slug=X]` — alle Fehler-Mails neu parsen (nach Parser-Update)

**Deployment-Reihenfolge:**
1. Google-Workspace-User `airbnb-bot@…` anlegen, App-Passwort generieren
2. Bot-Adresse zum Google-Groups-Verteiler hinzufügen (empfängt alle Airbnb-Mails)
3. `AIRBNB_MAIL_HOST=imap.gmail.com`, `AIRBNB_MAIL_PORT=993`, `AIRBNB_MAIL_USER=…`, `AIRBNB_MAIL_PASSWORD=…` in `/opt/guesty-calendar-app/.env`
4. Property mit `provider: 'airbnb-mail'` in `data/properties.json` ergänzen (inkl. `airbnbListingId`, `airbnbIcalUrl`, `airbnbMailLabel` für den Gmail-Label-Filter, `static`)
5. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
6. Logs prüfen: Migration 013 applied, kein Zod-Error
7. Manueller Sync: `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>`
8. **Live-Daten-Kalibrierung**:
   - Nach 1-2 echten Mails: `SELECT subject, parse_status, parse_error FROM airbnb_mail_archive ORDER BY received_at DESC` ansehen
   - Subject-Patterns (`src/parsers/airbnb-mail/index.ts`) und Body-Regex (`confirmed-booking.ts` etc.) anhand der echten Mails justieren
   - `npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors --slug=X` zum Backfill

**Rollback**: Property aus `properties.json` entfernen, restart. DB-Rows können bleiben, Migration ist additive.

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
- **Widget i18n (DE/EN)**: the booking widget is fully bilingual — all UI labels, the
  booking-email body, ARIA labels and currency/date formatting live in a `de`/`en` translations
  object in `calendar.js`. Language selection (`detectLanguage()`) precedence: **`?lang=de|en`
  URL param (if valid) > browser language > `de` default**. Embed an English page via
  `/p/:slug?lang=en` (append the param to the iframe `src`). `detectLanguage()` runs before any
  network call and sets `document.documentElement.lang`, so there is no English-flash for DE
  visitors. Adding a new string means adding the key to BOTH language blocks.

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
- **Airbnb money fields**: `hostPayout`/`subTotalPrice` are NET of the Airbnb commission (host
  side) — NOT what the guest paid. The guest-paid amount = `fareAccommodationAdjusted` (accommodation
  net of guest discounts like length-of-stay) `+ fareCleaning + totalTaxes`. `invoiceItems`: `LOSD`
  = length-of-stay discount (guest discount), `PCM` = "Host channel fee" (commission, NOT a guest
  discount). See the Airbnb-invoice rule under Document Generation.

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
