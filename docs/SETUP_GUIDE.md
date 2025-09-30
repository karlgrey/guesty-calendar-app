# Setup Guide

Complete guide to set up the Guesty Calendar App from scratch.

## Prerequisites

- **Node.js**: >= 18.0.0
- **npm**: >= 8.0.0
- **Guesty Account**: With API access enabled

## Step 1: Get Guesty API Credentials

### Generate OAuth Credentials

1. Log in to your Guesty account
2. Navigate to **Settings** → **API** → **Open API**
3. Click **"Generate new API credentials"**
4. Give it a name (e.g., "Calendar App")
5. Copy the **Client ID** and **Client Secret** (only shown once!)

### Find Your Property ID

Run the test script to discover your property ID:

```bash
node test-auth.js
```

This will:
- Authenticate with Guesty
- List all your properties with their IDs
- Show property details (name, address, capacity)

Copy the property ID for the property you want to use.

## Step 2: Install Dependencies

```bash
npm install
```

This installs:
- Express (web server)
- TypeScript (type safety)
- better-sqlite3 (database)
- Zod (validation)
- Pino (logging)

## Step 3: Configure Environment

Create `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Guesty OAuth Configuration
GUESTY_CLIENT_ID=0oaqsin3xcWX8kt035d7
GUESTY_CLIENT_SECRET=jzoBKqiLR4w4u2ZH9PG-tfrwTjsIxIMzs-U0IGgoqJ7yjL4iQi9V_kfr2y5Gn8NF
GUESTY_PROPERTY_ID=686d1e927ae7af00234115ad

# Booking Configuration
BOOKING_RECIPIENT_EMAIL=booking@farmhouse-prasser.de

# Property Configuration (optional)
PROPERTY_CURRENCY=EUR
PROPERTY_TIMEZONE=Europe/Berlin
```

**Important**: Never commit `.env` to version control!

## Step 4: Initialize Database

```bash
npm run db:init
```

This creates:
- `data/` directory
- `calendar.db` SQLite database
- Database tables (listings, availability)

## Step 5: Sync Data from Guesty

```bash
npm run sync
```

This will:
- Authenticate with Guesty OAuth
- Fetch property details (capacity, pricing, fees)
- Fetch 12 months of availability data
- Store everything in SQLite cache

**Expected output:**
```
✓ Database already initialized
🚀 Starting ETL job
Step 1/2: Syncing listing data...
  API Guesty /listings/XXX - 200 (1050ms)
  Listing synced successfully
Step 2/2: Syncing availability data...
  API Guesty /availability-pricing/api/calendar/listings/XXX - 200 (993ms)
  Availability synced successfully (366 days)
✅ ETL job completed successfully
```

## Step 6: Start Development Server

```bash
npm run dev
```

Server starts at: `http://localhost:3000`

## Step 7: Test the Calendar

Open in browser:
```
http://localhost:3000
```

You should see:
- 2-month calendar view (1 on mobile)
- Available dates (white background)
- Booked dates (red background with strikethrough)
- Blocked dates (gray background)
- Guest selector (1-15 guests)
- Price per night displayed on each date

### Test Date Selection

1. **Select check-in**: Click any available date
2. **Select check-out**: Click another available date
3. **View quote**: Automatic price breakdown appears:
   - Accommodation fare (nightly rate × nights)
   - Weekly/monthly discount (if applicable)
   - Cleaning fee (€350)
   - Extra guest fee (€100 per guest over 5)
   - Total price
4. **Toggle pricing details**: Click "Show pricing details"
5. **Request booking**: Click "Request to Book"

## Project Structure

```
guesty-calendar-app/
├── src/
│   ├── config/          # Configuration with Zod validation
│   ├── db/              # SQLite database connection
│   ├── jobs/            # ETL sync jobs (listing, availability)
│   ├── mappers/         # Guesty → Internal data mapping
│   ├── middleware/      # Express middleware (CORS, logging)
│   ├── repositories/    # Database repositories
│   ├── routes/          # API route handlers
│   ├── scripts/         # Database init, manual sync
│   ├── services/        # Guesty OAuth client
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Logger, errors, helpers
│   ├── app.ts           # Express app setup
│   └── index.ts         # Application entry point
├── public/
│   ├── index.html       # Calendar UI HTML
│   ├── calendar.css     # Calendar styles (responsive)
│   └── calendar.js      # Calendar component (vanilla JS)
├── docs/
│   ├── SETUP_GUIDE.md   # This file
│   ├── API_ENDPOINTS.md # API documentation
│   ├── CALENDAR_UI.md   # UI component docs
│   ├── DATA_MODEL.md    # Database schema
│   └── ETL_JOBS.md      # Sync jobs documentation
├── data/
│   └── calendar.db      # SQLite database (gitignored)
├── .env                 # Environment config (gitignored)
├── .env.example         # Template for .env
├── schema.sql           # Database schema definition
├── package.json         # Dependencies and scripts
└── tsconfig.json        # TypeScript configuration
```

## Available Scripts

### Development
```bash
npm run dev              # Start with hot reload (tsx watch)
```

### Production
```bash
npm run build            # Compile TypeScript to dist/
npm start               # Run compiled code
```

### Data Management
```bash
npm run sync            # Sync data from Guesty API
npm run sync:force      # Force sync (ignore cache freshness)
npm run db:init         # Initialize database
npm run db:reset        # Reset database (deletes all data!)
```

### Testing
```bash
node test-auth.js       # Test OAuth authentication
node test-calendar-api.js  # Test calendar API response format
```

### Database Queries
```bash
sqlite3 data/calendar.db "SELECT * FROM listings;"
sqlite3 data/calendar.db "SELECT date, status, price FROM availability LIMIT 10;"
```

## API Endpoints

### Public Endpoints

**GET /listing**
- Returns property details (capacity, pricing, fees, terms)

**GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD**
- Returns daily availability for date range
- Includes status, price, min nights per day

**GET /quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N**
- Returns complete price quote with breakdown
- Includes discounts, fees, taxes

### Admin Endpoints

**POST /sync/all** (optionally with `?force=true`)
- Trigger manual sync of listing + availability

**GET /health**
- Health check endpoint

See [API_ENDPOINTS.md](./API_ENDPOINTS.md) for detailed documentation.

## OAuth Authentication Flow

The app uses OAuth 2.0 Client Credentials flow:

1. **Token Request**: App exchanges Client ID + Secret for access token
2. **Token Storage**: Token cached in memory (24-hour validity)
3. **API Requests**: Token sent as `Bearer` header
4. **Auto Refresh**: New token fetched when expired

**Rate Limits (OAuth endpoint):**
- 5 tokens per 24 hours per API key
- Token valid for 24 hours
- Reuse cached token to avoid limits

**Rate Limits (Open API endpoints):**
- 15 requests per second
- 120 requests per minute
- 5,000 requests per hour

## Data Sync Strategy

### Automatic Sync

ETL job runs every **6 hours** (configurable):
- Syncs listing if cache older than 24 hours
- Syncs availability if cache older than 6 hours
- Maintains 12 months of future availability

### Manual Sync

```bash
npm run sync              # Respects cache TTLs
npm run sync:force        # Forces refresh
curl -X POST http://localhost:3000/sync/all?force=true
```

### Cache TTLs

| Data Type | Default TTL | Configurable Via |
|-----------|-------------|------------------|
| Listing | 24 hours | `CACHE_LISTING_TTL` |
| Availability | 6 hours | `CACHE_AVAILABILITY_TTL` |
| Quotes | 1 hour | `CACHE_QUOTE_TTL` |

## Troubleshooting

### OAuth Rate Limit (429 Too Many Requests)

**Problem**: Hit 5 token limit in 24 hours

**Solution**: Wait for rate limit reset (24 hours from first token request)

**Prevention**: Token is cached for 24 hours - reuse it

### No Availability Data

**Problem**: Calendar shows empty or "no data"

**Solution**:
```bash
# Force sync to fetch fresh data
npm run sync:force

# Or via API
curl -X POST http://localhost:3000/sync/all?force=true
```

### Database Locked

**Problem**: SQLite database locked error

**Solution**:
```bash
# Stop all running instances
pkill -f "npm run dev"

# Restart
npm run dev
```

### Port Already in Use

**Problem**: Port 3000 already in use

**Solution**:
```bash
# Change port in .env
PORT=3001

# Or kill process using port 3000
lsof -ti:3000 | xargs kill -9
```

## Configuration Options

All environment variables with defaults:

```env
# Server
NODE_ENV=development
PORT=3000
HOST=localhost

# Guesty OAuth
GUESTY_CLIENT_ID=required
GUESTY_CLIENT_SECRET=required
GUESTY_API_URL=https://open-api.guesty.com/v1
GUESTY_OAUTH_URL=https://open-api.guesty.com/oauth2/token
GUESTY_PROPERTY_ID=required

# Property
PROPERTY_CURRENCY=EUR
PROPERTY_TIMEZONE=Europe/Berlin

# Booking
BOOKING_RECIPIENT_EMAIL=required
BOOKING_SENDER_NAME=Farmhouse Prasser

# Cache TTLs (hours)
CACHE_LISTING_TTL=24
CACHE_AVAILABILITY_TTL=6
CACHE_QUOTE_TTL=1

# Database
DATABASE_PATH=./data/calendar.db

# Logging
LOG_LEVEL=info
LOG_PRETTY=true
```

## Production Deployment

### Environment Setup

1. Set `NODE_ENV=production`
2. Disable pretty logging: `LOG_PRETTY=false`
3. Use absolute database path: `DATABASE_PATH=/var/lib/calendar/calendar.db`

### Build and Run

```bash
npm run build
npm start
```

### Process Management

Use PM2 for process management:

```bash
npm install -g pm2
pm2 start dist/index.js --name calendar-app
pm2 save
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name calendar.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Next Steps

1. **Customize UI**: Edit `public/calendar.css` for branding
2. **Add Analytics**: Track bookings with Google Analytics
3. **Email Integration**: Replace mailto with email service
4. **Multi-Property**: Extend to support multiple properties
5. **Admin Dashboard**: Add admin interface for manual overrides

## Support

For issues or questions:
- Check [API_ENDPOINTS.md](./API_ENDPOINTS.md) for API docs
- Check [CALENDAR_UI.md](./CALENDAR_UI.md) for UI docs
- Review logs: `tail -f logs/app.log` (if file logging enabled)
- Test auth: `node test-auth.js`

## Current Setup Summary

**Your Property:**
- Name: Design-Farmhouse in der Natur
- ID: `686d1e927ae7af00234115ad`
- Capacity: 15 guests
- Base Price: €1,500/night

**Live Data:**
- 366 days of availability synced
- Real bookings from Guesty
- Automatic sync every 6 hours
- OAuth token cached for 24 hours

**Calendar UI:**
- http://localhost:3000
- Responsive (mobile + desktop)
- Guest selector (1-15)
- Price breakdown with discounts
- Request to Book via email