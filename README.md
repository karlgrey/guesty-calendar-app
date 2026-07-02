# Guesty Calendar App

An Airbnb-style booking interface for a single property, powered by the Guesty API. This service provides a fast, localized, and accessible calendar with overlay datepicker and intelligent caching.

## Features

### Frontend (Airbnb-style UI)
- **Compact Booking Header**: Always-visible price, dates, guests, and CTA
- **Overlay Datepicker**: Two-month view (desktop) or fullscreen (mobile)
- **Full Localization**: German default, English auto-detect (dates, currency, plurals)
- **Pricing Details Overlay**: Complete breakdown with discounts, fees, and taxes
- **Keyboard Navigation**: Full arrow key support with focus trap
- **Accessibility**: WCAG 2.1 AA compliant with screen reader support
- **Auto-selection**: First available date + minNights on load
- **Request to Book**: Localized mailto links with complete details

### Backend
- **SQLite Cache**: Fast responses with hourly ETL refresh
- **Quote Engine**: Local calculation with all fees, taxes, and discounts
- **Scheduled Sync**: Automatic hourly updates with jitter
- **Rate Limiting**: Bottleneck-based request queuing with exponential backoff retry
- **OAuth Resilience**: Automatic retry logic for OAuth token requests
- **Property Nickname**: Supports nickname field from Guesty API
- **Type-Safe**: Written in TypeScript with full type definitions
- **Observable**: Comprehensive logging for monitoring

### Guest-Reply System (Hostex)
- **Message Sync**: Fetches Hostex conversations per property and persists them in `message_threads` + `messages`
- **AI Drafts**: Generates reply drafts via Claude (`claude-sonnet-4-6`) using Voice style and per-property facts from the knowledge vault; capped at 10 drafts per property per ETL run; only threads with guest activity in the last 72 hours
- **Admin UI**: `/admin/messages` lists open threads and `/admin/messages/:threadId` shows history with editable draft, send/discard/regenerate/manual actions
- **Feedback Loop**: "Passt nicht?" form records feedback and triggers an AI-proposed vault edit; `/admin/suggestions` lets you review, approve (writes + git-commits to vault), or discard

## Architecture

```
┌─────────────────┐
│   Website       │
│   (Frontend)    │
└────────┬────────┘
         │
         │ HTTP
         ▼
┌─────────────────┐
│   Node.js       │
│   Service       │
│   (Express)     │
└────────┬────────┘
         │
         ├─────────┐
         │         │
         ▼         ▼
┌─────────────┐  ┌─────────────┐
│   SQLite    │  │   Guesty    │
│   Cache     │  │   API       │
└─────────────┘  └─────────────┘
```

## Quick Start

**👉 See [SETUP_GUIDE.md](docs/SETUP_GUIDE.md) for detailed setup instructions**

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Guesty account with OAuth credentials

### Installation

1. **Get Guesty OAuth credentials** (Client ID + Secret)
   ```bash
   # Test authentication and find your property ID
   node test-auth.js
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your OAuth credentials and property ID
   ```

4. **Initialize database:**
   ```bash
   npm run db:init
   ```

5. **Sync data from Guesty:**
   ```bash
   npm run sync
   ```

6. **Start server:**
   ```bash
   npm run dev
   ```

7. **Open calendar:**
   ```
   http://localhost:3000
   ```

The ETL job runs automatically every hour (with jitter) to keep data fresh.

## Configuration

All configuration is done via environment variables. See `.env.example` for all available options.

### Required Configuration

```env
# Guesty OAuth API
GUESTY_CLIENT_ID=your_client_id
GUESTY_CLIENT_SECRET=your_client_secret
GUESTY_PROPERTY_ID=your_property_id

# Booking
BOOKING_RECIPIENT_EMAIL=booking@example.com
```

### Optional Configuration

```env
# Server
PORT=3000
HOST=localhost

# Property
PROPERTY_CURRENCY=EUR
PROPERTY_TIMEZONE=Europe/Berlin

# Cache TTLs (hours)
# CACHE_AVAILABILITY_TTL also controls ETL scheduler interval
CACHE_LISTING_TTL=24
CACHE_AVAILABILITY_TTL=1  # Hourly refresh with jitter
CACHE_QUOTE_TTL=1

# Database
DATABASE_PATH=./data/calendar.db

# Logging
LOG_LEVEL=info
LOG_PRETTY=true

# AI + Vault (Guest-Reply System)
ANTHROPIC_API_KEY=sk-ant-...   # Required for AI draft generation and vault suggestions
VAULT_PATH=/path/to/vault      # Absolute path to the knowledge vault repo; enables AI drafts and feedback loop
```

`VAULT_PATH` and `ANTHROPIC_API_KEY` are optional — the guest-reply UI works without them, but AI draft generation and the vault feedback loop are disabled. Per-property vault notes are configured via the `vaultNote` field in `data/properties.json` (e.g. `"vaultNote": "Farmhouse.md"` maps to `Areas/Hosting/Properties/Farmhouse.md` in the vault).

## API Endpoints

### Public Endpoints

**GET /listing**

Get property information (accommodates, pricing, taxes, terms).

**GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD**

Get daily availability and pricing for a date range.

**GET /quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N**

Get complete price quote with breakdown (uses cached data).

See **[API Endpoints Documentation](docs/API_ENDPOINTS.md)** for detailed request/response examples.

### Health Check

**GET /health** - Basic health check
**GET /health/detailed** - Database stats and config
**GET /health/ready** - Readiness probe
**GET /health/live** - Liveness probe

### Data Sync (Admin)

**POST /sync/all** - Sync listing + availability (add `?force=true`)
**POST /sync/listing** - Sync listing only
**POST /sync/availability** - Sync availability only
**GET /sync/status** - Scheduler status

### Guest-Reply Admin UI (auth-protected)

**GET /admin/messages** - Open Hostex threads awaiting reply; shows last-sync timestamp and "Jetzt syncen" button
**GET /admin/messages/:threadId** - Thread detail with conversation history, editable draft, send/discard/regenerate/manual actions, and "Passt nicht?" feedback form
**POST /admin/messages/sync** - Trigger immediate message sync + draft generation for all Hostex properties (async, returns immediately)
**POST /admin/messages/:threadId/draft** - Save a manual draft
**POST /admin/messages/drafts/:draftId/send** - Approve and send draft (editable body, atomic send guard)
**POST /admin/messages/drafts/:draftId/discard** - Discard draft
**POST /admin/messages/:threadId/regenerate** - Discard current draft and generate a fresh AI draft
**POST /admin/messages/:threadId/feedback** - Submit feedback (ton/fakt/einmalig); triggers AI vault suggestion for ton/fakt categories

**GET /admin/suggestions** - Pending AI-proposed vault edits with rationale
**POST /admin/suggestions/:id/approve** - Apply suggestion: writes + git-commits to vault
**POST /admin/suggestions/:id/discard** - Discard suggestion

See **[API Endpoints Documentation](docs/API_ENDPOINTS.md)** for full detail.

## Development

### Project Structure

```
guesty-calendar-app/
├── src/
│   ├── config/          # Configuration management
│   ├── db/              # Database connection and utilities
│   ├── jobs/            # ETL jobs and scheduler
│   ├── mappers/         # Guesty → Internal data mapping
│   ├── middleware/      # Express middleware
│   ├── repositories/    # Database repositories
│   ├── routes/          # API route handlers
│   ├── scripts/         # Database and sync scripts
│   ├── services/        # External services (Guesty client)
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Utility functions (logger, errors)
│   ├── app.ts           # Express app setup
│   └── index.ts         # Application entry point
├── public/              # Frontend assets
│   ├── index.html       # Booking header + overlays
│   ├── calendar.js      # Calendar component (localized)
│   └── calendar.css     # Styles (mobile-first)
├── docs/                # Documentation
│   ├── CALENDAR_UI.md   # Frontend documentation
│   ├── ETL_JOBS.md      # Scheduling and sync
│   ├── API_ENDPOINTS.md # API reference
│   ├── DATA_MODEL.md    # Database schema
│   ├── FIELD_MAPPING.md # Guesty → Internal mapping
│   └── GUESTY_API_ANALYSIS.md
├── fixtures/            # Sample API responses
├── schema.sql           # Database schema
├── package.json
├── tsconfig.json
└── .env.example
```

### Scripts

```bash
# Development
npm run dev              # Start with hot reload

# Build
npm run build            # Compile TypeScript
npm start               # Run production build

# Data Sync
npm run sync            # Sync data from Guesty API
npm run sync:force      # Force sync (ignore cache freshness)

# Database
npm run db:init         # Initialize database
npm run db:reset        # Reset database (deletes all data!)

# Code Quality
npm run lint            # Lint code
npm test               # Run tests
```

### Database Management

**Initialize database:**
```bash
npm run db:init
```

**Reset database (WARNING: deletes all data):**
```bash
npm run db:reset
```

**Manual database access:**
```bash
sqlite3 data/calendar.db
```

## Documentation

- **[Setup Guide](docs/SETUP_GUIDE.md)** - Complete setup instructions (START HERE!)
- **[API Endpoints](docs/API_ENDPOINTS.md)** - Public API reference
- **[Calendar UI](docs/CALENDAR_UI.md)** - Frontend calendar component
- **[Guesty API Analysis](docs/GUESTY_API_ANALYSIS.md)** - Complete API documentation
- **[Data Model](docs/DATA_MODEL.md)** - Database schema and design
- **[Field Mapping](docs/FIELD_MAPPING.md)** - Guesty → Internal mapping reference
- **[ETL Jobs](docs/ETL_JOBS.md)** - Data sync jobs and scheduling

## Technology Stack

**Backend:**
- **Runtime**: Node.js 18+
- **Language**: TypeScript
- **Web Framework**: Express
- **Database**: SQLite (better-sqlite3)
- **Rate Limiting**: Bottleneck
- **Validation**: Zod
- **Logging**: Pino
- **Development**: tsx (TypeScript executor)

**Frontend:**
- **HTML/CSS/JavaScript**: Vanilla (no framework)
- **Responsive Design**: CSS Grid, Flexbox
- **API Integration**: Fetch API

## Cache Strategy

The application uses a multi-tier caching strategy:

- **Listings**: 24 hours TTL (infrequent changes)
- **Availability**: 6 hours TTL (moderate changes)
- **Quotes**: 1 hour TTL (computed on-demand)

Cached data is automatically refreshed when stale.

## Logging

Structured JSON logging powered by Pino:

- **Development**: Pretty-printed, colorized logs
- **Production**: JSON logs for log aggregation

Log levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`

## Error Handling

Custom error classes for different scenarios:

- `ConfigError` - Configuration issues
- `DatabaseError` - Database operations
- `ExternalApiError` - Guesty API failures
- `ValidationError` - Invalid input
- `NotFoundError` - Resource not found

All errors are logged and returned with appropriate HTTP status codes.

## Future Enhancements

- Direct booking integration
- Multi-listing support
- Advanced pricing rules (seasonal, custom discounts)
- Webhook support for real-time updates
- Admin dashboard
- Analytics and reporting

## License

MIT

## Support

For issues and questions, please open an issue on the GitHub repository.