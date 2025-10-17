# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js/TypeScript service that provides an Airbnb-style booking calendar for a single Guesty property. The service caches Guesty API data in SQLite and serves it through a public API with a vanilla JavaScript frontend.

## Development Commands

### Running the Application
```bash
npm run dev              # Development with hot reload (tsx watch)
npm run build            # Compile TypeScript to dist/
npm start               # Run production build from dist/
```

### Data Management
```bash
npm run sync            # Sync data from Guesty API (respects cache freshness)
npm run sync:force      # Force sync (ignore cache, refresh all data)
npm run db:init         # Initialize database (creates schema from schema.sql)
npm run db:migrate      # Run pending database migrations
npm run db:reset        # Drop and recreate database (WARNING: deletes all data)
```

### Code Quality
```bash
npm run lint            # ESLint on src/**/*.ts
npm test               # Run tests with Vitest
```

### Access Points
- Main calendar UI: `http://localhost:3000`
- Admin dashboard: `http://localhost:3000/admin` (requires authentication)
- Login page: `http://localhost:3000/auth/login`
- Health check: `http://localhost:3000/health`
- Detailed health: `http://localhost:3000/health/detailed`

## Architecture Overview

### Data Flow
1. **ETL Jobs** (`src/jobs/`) fetch data from Guesty API on startup and then hourly (configurable via `CACHE_AVAILABILITY_TTL`)
2. **Guesty Client** (`src/services/guesty-client.ts`) handles OAuth authentication and rate-limited API requests using Bottleneck
3. **Mappers** (`src/mappers/`) transform Guesty API responses into internal data models
4. **Repositories** (`src/repositories/`) handle SQLite operations (CRUD + cache freshness checks)
5. **Routes** (`src/routes/`) serve public API endpoints for listing, availability, and quotes
6. **Pricing Calculator** (`src/services/pricing-calculator.ts`) computes quotes locally using cached data
7. **Frontend** (`public/`) vanilla JavaScript calendar with overlay datepicker

### Rate Limiting Strategy
The `GuestyClient` uses Bottleneck to enforce conservative limits:
- 10 requests/second (buffer below Guesty's 15 req/sec limit)
- 10 concurrent requests (buffer below Guesty's 15 concurrent limit)
- Exponential backoff with jitter for 429 responses
- OAuth token requests have retry logic (up to 5 attempts with backoff)

### Cache Strategy
- **Listings**: 24 hours TTL (infrequent changes)
- **Availability**: Configurable via `CACHE_AVAILABILITY_TTL` (default 60 minutes)
- **Quotes**: Computed on-demand from cached data, stored with 60 minute TTL

The ETL scheduler interval is controlled by `CACHE_AVAILABILITY_TTL` - jobs run with ±5% jitter to prevent thundering herd.

### Error Handling
Custom error classes in `src/utils/errors.ts`:
- `ConfigError` - Configuration issues (500)
- `DatabaseError` - Database operations (500)
- `ExternalApiError` - Guesty API failures (502 or API status)
- `ValidationError` - Invalid input (400)
- `NotFoundError` - Resource not found (404)
- `CacheMissError` - Cache miss (flow control, not shown to user)

All errors extend `AppError` and include structured logging via Pino.

### Authentication & Authorization
The admin panel is protected with Google OAuth 2.0 authentication:
- **Passport.js** with Google OAuth strategy (`src/config/auth.ts`)
- **Session-based authentication** using `express-session` with secure cookies
- **Email whitelist** system for access control (`ADMIN_ALLOWED_EMAILS` env var)
- **Protected routes** using `requireAuth` middleware (`src/middleware/auth.ts`)
- **Authentication routes** (`src/routes/auth.ts`):
  - `GET /auth/login` - Login page with Google sign-in button
  - `GET /auth/google` - Initiates OAuth flow
  - `GET /auth/google/callback` - OAuth callback handler
  - `GET /auth/logout` - Logout and clear session
  - `GET /auth/unauthorized` - Unauthorized access page

Session configuration:
- Secure cookies in production (HTTPS only)
- HttpOnly cookies (XSS protection)
- 24-hour session lifetime
- Session data stored in memory (consider Redis for multi-instance deployments)

## Key Patterns

### Database Operations
- Use `better-sqlite3` synchronous API for all queries
- Always check cache freshness before fetching from API
- Repositories handle cache logic (check TTL → fetch if stale → upsert)
- Foreign keys enabled (`PRAGMA foreign_keys = ON`)
- Triggers auto-update `updated_at` timestamps

### Date Handling
- Store dates as ISO 8601 strings (`YYYY-MM-DD` for dates, full ISO for timestamps)
- All availability dates are in the property's timezone (`PROPERTY_TIMEZONE`)
- Always use UTC for `last_synced_at` and cache expiry fields

### Logging
- Use structured logging with Pino (`logger.info({ context }, 'message')`)
- Development: pretty-printed logs (`LOG_PRETTY=true`)
- Production: JSON logs for aggregation
- Log API calls with `logApiCall(service, endpoint, status, duration)`

### Testing Patterns
When writing tests:
- Use Vitest for test runner
- Mock database operations to avoid file I/O
- Mock Guesty API responses using fixtures from `fixtures/` directory
- Test error cases (validation, cache miss, API errors)

## Important Files

### Configuration
- `.env` - Environment variables (never commit, use `.env.example` as template)
- `src/config/index.ts` - Config validation with Zod, exports typed `config` object
- Schema: `schema.sql` (executed by `src/scripts/init-db.ts`)

### Critical Services
- `src/services/guesty-client.ts` - OAuth + rate-limited Guesty API client
- `src/services/pricing-calculator.ts` - Local quote computation (no API calls)
- `src/jobs/scheduler.ts` - ETL job scheduling with jitter
- `src/jobs/etl-job.ts` - Orchestrates listing + availability sync

### Type Definitions
- `src/types/guesty.ts` - Guesty API response types
- `src/types/models.ts` - Internal data models (matches DB schema)

## Common Tasks

### Adding a New API Endpoint
1. Create route handler in `src/routes/` (use Express Router)
2. Add validation for request parameters (throw `ValidationError` for invalid input)
3. Use repositories to fetch data (they handle cache logic)
4. Return JSON with appropriate status codes
5. Register route in `src/app.ts`

### Modifying Database Schema
1. Create a new migration file in `src/db/migrations/` with format `NNN_description.sql` (e.g., `002_add_bookings_table.sql`)
2. Write SQL statements in the migration file (CREATE TABLE, ALTER TABLE, etc.)
3. Update type definitions in `src/types/models.ts`
4. Update mappers if Guesty API fields are involved
5. Update repositories with new query logic
6. Run `npm run db:migrate` to apply migrations manually, or restart the app (migrations run automatically on startup)

**Migration System:**
- Migrations are stored in `src/db/migrations/` as `.sql` files
- Migrations run automatically on application startup
- Applied migrations are tracked in the `migrations` table
- Migrations are applied in alphabetical order (use numeric prefix like `001_`, `002_`)
- Each migration runs in a transaction (atomic)
- To manually run migrations: `npm run db:migrate`

**Creating a Migration:**
```bash
# Create a new migration file
cat > src/db/migrations/002_add_feature.sql << 'EOF'
-- Migration: Add new feature
-- Created: 2025-10-17
-- Description: Add support for...

CREATE TABLE IF NOT EXISTS new_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ...
);
EOF

# Migrations will run automatically on next app start
npm run dev
```

### Debugging Rate Limits
- Check `getRateLimitInfo()` on GuestyClient instance
- Look for "Approaching rate limit threshold" warnings in logs
- Adjust Bottleneck config in `GuestyClient` constructor if needed
- Note: OAuth endpoint has separate retry logic (5 attempts)

### Frontend Modifications
- UI is in `public/` directory (served as static files)
- `calendar.js` contains all calendar logic (vanilla JS, no framework)
- `calendar.css` is mobile-first responsive design
- API calls use Fetch API (see `fetchListing`, `fetchAvailability`, `fetchQuote`)

## Environment Variables

Required:
- `GUESTY_CLIENT_ID` - OAuth client ID for Guesty API
- `GUESTY_CLIENT_SECRET` - OAuth client secret for Guesty API
- `GUESTY_PROPERTY_ID` - Guesty listing ID to sync
- `BOOKING_RECIPIENT_EMAIL` - Email for booking requests

Authentication (required for admin access):
- `BASE_URL` - Full public URL (e.g., `https://guesty.remoterepublic.com` or `http://localhost:3000`)
- `SESSION_SECRET` - Random string (32+ chars, generate with `openssl rand -base64 32`)
- `GOOGLE_CLIENT_ID` - Google OAuth client ID (from Google Cloud Console)
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `ADMIN_ALLOWED_EMAILS` - Comma-separated email whitelist (e.g., `user@example.com,admin@example.com`)

Common optional:
- `PORT` - Server port (default: 3000)
- `CACHE_AVAILABILITY_TTL` - Minutes between ETL runs (default: 60)
- `LOG_LEVEL` - Pino log level (default: info)
- `DATABASE_PATH` - SQLite file path (default: ./data/calendar.db)

See `.env.example` for full list with descriptions.

## Guesty API Quirks

- OAuth tokens valid for 24 hours (cached until 5 min before expiry)
- Calendar endpoint returns `{ status, data: { days: [...] } }` - unwrap `data.days`
- Rate limits: 15 req/sec, 120 req/min, 5000 req/hour (tracked via response headers)
- Date format: `YYYY-MM-DD` for date parameters
- Nickname field (`listings.nickname`) may be null - fallback to `title`
- Tax `appliedOnFees` array uses codes: `AF` = accommodation fare, `CF`/`CLEANING` = cleaning fee

## Setting Up Google OAuth

To enable admin authentication, you need to create OAuth 2.0 credentials in Google Cloud Console:

### 1. Create OAuth Credentials
1. Go to [Google Cloud Console - Credentials](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select an existing one
3. Click **"Create Credentials"** → **"OAuth client ID"**
4. Configure the OAuth consent screen if prompted:
   - User type: External (for public access) or Internal (for Google Workspace)
   - App name: "Guesty Calendar Admin"
   - User support email: Your email
   - Authorized domains: Add your domain (e.g., `remoterepublic.com`)
5. Choose application type: **"Web application"**
6. Add authorized redirect URIs:
   - Development: `http://localhost:3000/auth/google/callback`
   - Production: `https://yourdomain.com/auth/google/callback`
7. Click **"Create"** and save the Client ID and Client Secret

### 2. Update Environment Variables
Add the credentials to your `.env` file:
```bash
BASE_URL=https://yourdomain.com
SESSION_SECRET=$(openssl rand -base64 32)
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
ADMIN_ALLOWED_EMAILS=micha@remoterepublic.com
```

### 3. Test Authentication
1. Restart the server: `npm run dev` or `pm2 restart guesty-calendar`
2. Visit `/auth/login` to test the login flow
3. Unauthorized emails will see an access denied message

### Security Notes
- Keep `SESSION_SECRET` and `GOOGLE_CLIENT_SECRET` confidential
- Use HTTPS in production (cookies are secure-only)
- Regularly review authorized emails in `ADMIN_ALLOWED_EMAILS`
- Consider using Google Workspace for internal-only access

## Production Deployment

The app is designed for deployment with PM2:
```bash
npm run build
pm2 start dist/index.js --name guesty-calendar
```

Key considerations:
- Scheduler starts automatically on boot (no separate cron needed)
- Database is created/initialized automatically if missing
- Graceful shutdown handles SIGTERM/SIGINT (closes DB, stops scheduler)
- Set `LOG_PRETTY=false` for production JSON logs
