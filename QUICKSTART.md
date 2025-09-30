# Quick Reference - Fresh Session

Use this file to quickly get back up to speed when starting a fresh coding session.

## Current State

✅ **Fully Functional Application** with live Guesty data

### What's Working

- ✅ OAuth 2.0 authentication with Guesty Open API
- ✅ 366 days of live availability data synced
- ✅ Real bookings and pricing from Guesty
- ✅ Responsive calendar UI (mobile + desktop)
- ✅ Guest selector with validation (1-15 guests)
- ✅ Price quotes with full breakdown (discounts, fees, taxes)
- ✅ "Request to Book" mailto functionality
- ✅ Automatic data sync every 6 hours
- ✅ SQLite caching for fast responses

## Start Working Immediately

### 1. Start Development Server

```bash
npm run dev
```

Server: http://localhost:3000

### 2. View Calendar

Open: http://localhost:3000

### 3. Common Tasks

**Sync fresh data from Guesty:**
```bash
npm run sync:force
```

**Check database:**
```bash
sqlite3 data/calendar.db "SELECT COUNT(*) FROM availability;"
```

**Test authentication:**
```bash
node test-auth.js
```

**View logs:** (server must be running)
```bash
# Logs appear in terminal where npm run dev is running
```

## Key Files to Know

### Frontend (Calendar UI)
- `public/index.html` - HTML structure
- `public/calendar.css` - Styles (responsive design)
- `public/calendar.js` - Calendar component (BookingCalendar class)

### Backend (API & Sync)
- `src/index.ts` - Application entry point
- `src/app.ts` - Express app configuration
- `src/routes/` - API endpoints (listing, availability, quote, sync)
- `src/services/guesty-client.ts` - Guesty OAuth client
- `src/jobs/` - ETL sync jobs (listing, availability)

### Configuration
- `.env` - Environment variables (OAuth creds, property ID)
- `schema.sql` - Database schema
- `tsconfig.json` - TypeScript config

### Documentation
- `docs/SETUP_GUIDE.md` - Complete setup instructions
- `docs/API_ENDPOINTS.md` - API documentation
- `docs/CALENDAR_UI.md` - UI component docs

## Current Configuration

```env
GUESTY_CLIENT_ID=0oaqsin3xcWX8kt035d7
GUESTY_CLIENT_SECRET=jzoBKqiLR4w4u2ZH9PG-tfrwTjsIxIMzs-U0IGgoqJ7yjL4iQi9V_kfr2y5Gn8NF
GUESTY_PROPERTY_ID=686d1e927ae7af00234115ad
BOOKING_RECIPIENT_EMAIL=booking@farmhouse-prasser.de
```

**Property:**
- Name: Design-Farmhouse in der Natur
- Capacity: 15 guests
- Base Price: €1,500/night
- Cleaning Fee: €350
- Extra Guest Fee: €100/guest (after 5 guests)

## API Endpoints

**Base URL:** http://localhost:3000

### Public Endpoints
- `GET /` - Calendar UI
- `GET /listing` - Property details
- `GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD` - Daily availability
- `GET /quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N` - Price quote
- `GET /health` - Health check

### Admin Endpoints
- `POST /sync/all` - Manual sync (optional `?force=true`)
- `GET /sync/status` - Sync scheduler status

## Recent Changes

### OAuth Implementation
- Replaced API key auth with OAuth 2.0 client credentials flow
- Token cached for 24 hours with automatic refresh
- Updated types to match actual Guesty API response format
- Fixed calendar endpoint to unwrap `{ status, data: { days: [...] } }`

### Calendar UI Features
- Added guest selector with capacity validation
- Implemented price breakdown with toggle
- Added "Request to Book" mailto with full details
- Weekly/monthly discount display
- Responsive 1-2 month view

### Data Sync
- Listing synced (24h TTL)
- Availability synced (6h TTL, 12 months ahead)
- Automatic background sync every 6 hours
- Manual sync via API or CLI

## Troubleshooting

### Server Won't Start
```bash
# Check if port is in use
lsof -ti:3000

# Kill existing process
lsof -ti:3000 | xargs kill -9

# Restart
npm run dev
```

### No Data in Calendar
```bash
# Force sync
npm run sync:force

# Check database
sqlite3 data/calendar.db "SELECT COUNT(*) FROM availability;"
```

### OAuth 429 Rate Limit
- OAuth endpoint: 5 tokens per 24 hours
- Token cached for 24 hours
- Wait for rate limit reset if exhausted
- Open API endpoints: 15/sec, 120/min, 5000/hr

### Database Locked
```bash
# Stop all instances
pkill -f "npm run dev"

# Restart
npm run dev
```

## Next Development Tasks

### Potential Enhancements
- [ ] Add real-time availability updates (webhooks)
- [ ] Multi-property support
- [ ] Admin dashboard for manual overrides
- [ ] Email service integration (replace mailto)
- [ ] Analytics tracking
- [ ] Keyboard navigation for calendar
- [ ] Touch gestures for mobile
- [ ] Loading states for API calls
- [ ] Optimistic UI updates

### Code Improvements
- [ ] Add unit tests (Jest)
- [ ] Add integration tests
- [ ] Set up CI/CD pipeline
- [ ] Add error monitoring (Sentry)
- [ ] Implement retry logic with exponential backoff
- [ ] Add request logging middleware
- [ ] Optimize bundle size

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Browser                       │
│  ┌─────────────────────────────────────────┐   │
│  │  Calendar UI (Vanilla JS)               │   │
│  │  - Date selection                       │   │
│  │  - Guest selector                       │   │
│  │  - Price breakdown                      │   │
│  └─────────────────────────────────────────┘   │
└─────────────────┬───────────────────────────────┘
                  │ HTTP
                  ▼
┌─────────────────────────────────────────────────┐
│           Express API Server                    │
│  ┌───────────────────────────────────────────┐ │
│  │ Routes (listing, availability, quote)     │ │
│  └───────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────┐ │
│  │ Services (Guesty OAuth Client)            │ │
│  └───────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────┐ │
│  │ Jobs (ETL sync every 6h)                  │ │
│  └───────────────────────────────────────────┘ │
└─────────┬───────────────────┬───────────────────┘
          │                   │
          ▼                   ▼
┌─────────────────┐  ┌─────────────────┐
│  SQLite Cache   │  │  Guesty API     │
│  - listings     │  │  - OAuth        │
│  - availability │  │  - Listings     │
│                 │  │  - Calendar     │
└─────────────────┘  └─────────────────┘
```

## Useful Commands

```bash
# Development
npm run dev                    # Start dev server with hot reload
npm run build                  # Build TypeScript
npm start                      # Run production build

# Data Management
npm run sync                   # Sync data (respects cache)
npm run sync:force             # Force sync (ignore cache)
npm run db:init                # Initialize database
npm run db:reset               # Reset database (WARNING: deletes data!)

# Database Queries
sqlite3 data/calendar.db "SELECT * FROM listings;"
sqlite3 data/calendar.db "SELECT date, status, price FROM availability WHERE status = 'booked' LIMIT 10;"
sqlite3 data/calendar.db "SELECT COUNT(*) as total, status, COUNT(*) FROM availability GROUP BY status;"

# Testing
node test-auth.js              # Test OAuth auth
node test-calendar-api.js      # Test calendar API format
curl http://localhost:3000/health
curl "http://localhost:3000/listing" | jq
curl "http://localhost:3000/availability?from=2025-10-01&to=2025-10-10" | jq
curl "http://localhost:3000/quote?checkIn=2025-10-15&checkOut=2025-10-22&guests=10" | jq

# Logs
# Logs appear in terminal (LOG_PRETTY=true in dev)
# For production: LOG_PRETTY=false outputs JSON logs
```

## Environment Variables

```env
# Required
GUESTY_CLIENT_ID              # OAuth client ID
GUESTY_CLIENT_SECRET          # OAuth client secret
GUESTY_PROPERTY_ID            # Property to sync
BOOKING_RECIPIENT_EMAIL       # Email for booking requests

# Optional (with defaults)
NODE_ENV=development          # development | production
PORT=3000                     # Server port
HOST=localhost                # Server host
PROPERTY_CURRENCY=EUR         # Currency code
PROPERTY_TIMEZONE=Europe/Berlin  # IANA timezone
CACHE_LISTING_TTL=24          # Hours
CACHE_AVAILABILITY_TTL=6      # Hours
CACHE_QUOTE_TTL=1             # Hours
DATABASE_PATH=./data/calendar.db  # SQLite path
LOG_LEVEL=info                # fatal|error|warn|info|debug|trace
LOG_PRETTY=true               # Pretty logs (dev) or JSON (prod)
```

## Support & Documentation

- **Setup Issues**: See [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)
- **API Questions**: See [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md)
- **UI Questions**: See [docs/CALENDAR_UI.md](docs/CALENDAR_UI.md)
- **Database Schema**: See [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- **Guesty API**: See [docs/GUESTY_API_ANALYSIS.md](docs/GUESTY_API_ANALYSIS.md)

---

**Ready to code!** 🚀

Everything is set up and working. Just run `npm run dev` and you're good to go.