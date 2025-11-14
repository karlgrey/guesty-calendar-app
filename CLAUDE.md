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

# Manual testing
npx tsx src/scripts/test-force-sync.ts  # Test forced sync (bypasses cache)
npx tsx src/scripts/test-email.ts       # Send test weekly email immediately
npx tsx src/scripts/test-timezone.ts    # Verify timezone conversion for scheduling
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
- **Availability**: Configurable via `CACHE_AVAILABILITY_TTL` (default 30 minutes)
- **Quotes**: Computed on-demand from cached data, stored with 60 minute TTL

The ETL scheduler interval is controlled by `CACHE_AVAILABILITY_TTL` - jobs run with ±5% jitter to prevent thundering herd.

**Daily Forced Sync:**
- Runs every day at 2 AM (server time)
- Bypasses all cache checks and forces a complete data refresh
- Ensures customer data changes in Guesty are picked up within 24 hours
- Fetches 24 months of data (12 months past + 12 months future)
- Updates both availability and reservation data
- Scheduler checks hourly for the 2 AM trigger time

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

### Weekly Email Reports
The application sends automated weekly summary emails with property statistics and upcoming bookings.

**Features:**
- All-time statistics (total bookings, revenue, booked days)
- Next 5 upcoming bookings with guest details
- HTML and plain text email formats
- Timezone-aware scheduling
- Sent via Resend email service

**Configuration (`.env`):**
```bash
# Email Service
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM_ADDRESS=calendar@updates.yourdomain.com
EMAIL_FROM_NAME=Property Calendar

# Weekly Report Settings
WEEKLY_REPORT_ENABLED=TRUE
WEEKLY_REPORT_RECIPIENTS=email1@example.com,email2@example.com,email3@example.com
WEEKLY_REPORT_DAY=1        # 0=Sunday, 1=Monday, 2=Tuesday, etc.
WEEKLY_REPORT_HOUR=6       # Hour in property timezone (0-23)

# Property Configuration
PROPERTY_TIMEZONE=Europe/Berlin  # IANA timezone for scheduling
```

**How It Works:**
1. **Scheduler** (`src/jobs/scheduler.ts`) checks hourly if it's time to send the email
2. **Timezone Conversion**: Server time (UTC) is converted to property timezone using `date-fns-tz`
3. **Scheduling Logic** (`src/jobs/weekly-email.ts`):
   - Gets current UTC time
   - Converts to property timezone (e.g., Europe/Berlin)
   - Checks if current day matches `WEEKLY_REPORT_DAY`
   - Checks if current hour matches `WEEKLY_REPORT_HOUR`
4. **Email Generation**:
   - Fetches all-time statistics from database
   - Retrieves next 5 upcoming bookings
   - Generates HTML email with styled template
   - Sends via Resend API to all configured recipients

**Testing:**
```bash
# Test timezone conversion
npx tsx src/scripts/test-timezone.ts

# Send test email immediately (bypasses schedule check)
npx tsx src/scripts/test-email.ts
```

**Files:**
- `src/jobs/weekly-email.ts` - Email job logic and scheduling
- `src/services/email-templates.ts` - HTML and text email generation
- `src/services/email-service.ts` - Resend API integration
- `src/scripts/test-email.ts` - Manual email testing
- `src/scripts/test-timezone.ts` - Timezone conversion verification

**Important Notes:**
- Emails are sent at the configured hour in the **property's timezone**, not server timezone
- Server can run in any timezone (typically UTC) - conversion is automatic
- Handles daylight saving time (DST) changes automatically
- Schedule check runs every hour (controlled by ETL scheduler)
- Requires verified domain in Resend for multiple recipients

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

Email service (required for weekly reports):
- `RESEND_API_KEY` - API key from Resend (https://resend.com)
- `EMAIL_FROM_ADDRESS` - Sender email (must be from verified domain)
- `EMAIL_FROM_NAME` - Display name for sender
- `WEEKLY_REPORT_ENABLED` - Enable/disable weekly emails (TRUE/FALSE)
- `WEEKLY_REPORT_RECIPIENTS` - Comma-separated email list
- `WEEKLY_REPORT_DAY` - Day of week (0=Sunday, 1=Monday, etc.)
- `WEEKLY_REPORT_HOUR` - Hour in property timezone (0-23)

Common optional:
- `PORT` - Server port (default: 3000)
- `CACHE_AVAILABILITY_TTL` - Minutes between ETL runs (default: 60)
- `LOG_LEVEL` - Pino log level (default: info)
- `DATABASE_PATH` - SQLite file path (default: ./data/calendar.db)
- `PROPERTY_TIMEZONE` - IANA timezone (default: Europe/Berlin)

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

This section covers the complete server-side infrastructure setup for production deployment.

### Server Requirements

- **OS**: Ubuntu 20.04 LTS or newer (Debian-based recommended)
- **Node.js**: v18+ (use nvm for version management)
- **Memory**: Minimum 1GB RAM (2GB+ recommended)
- **Storage**: Minimum 10GB disk space
- **Network**: Public IP with domain pointing to server
- **Ports**: 80 (HTTP), 443 (HTTPS) open to public

### Initial Server Setup

#### 1. Create Deploy User
```bash
# Create non-root user for deployment
sudo adduser deploy
sudo usermod -aG sudo deploy

# Switch to deploy user
su - deploy
```

#### 2. Install Node.js via nvm
```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# Install Node.js LTS
nvm install --lts
nvm use --lts
nvm alias default node

# Verify installation
node --version
npm --version
```

#### 3. Install PM2 Process Manager
```bash
# Install PM2 globally
npm install -g pm2

# Set up PM2 to start on boot
pm2 startup systemd
# Run the command that PM2 outputs (with sudo)

# Save PM2 process list
pm2 save
```

#### 4. Clone and Setup Application
```bash
# Create application directory
sudo mkdir -p /opt/guesty-calendar-app
sudo chown deploy:deploy /opt/guesty-calendar-app

# Clone repository
cd /opt
git clone <your-repo-url> guesty-calendar-app
cd guesty-calendar-app

# Install dependencies
npm install

# Create data directory
mkdir -p data

# Copy environment file
cp .env.example .env
nano .env  # Edit with production values
```

### PM2 Process Management

#### Initial Deployment
```bash
# Build TypeScript
npm run build

# Start application with PM2
pm2 start dist/index.js --name guesty-calendar

# Save PM2 configuration
pm2 save

# Check status
pm2 list
pm2 logs guesty-calendar
```

#### Common PM2 Commands
```bash
# View logs
pm2 logs guesty-calendar           # Live logs
pm2 logs guesty-calendar --lines 100  # Last 100 lines

# Process management
pm2 restart guesty-calendar        # Restart app
pm2 stop guesty-calendar          # Stop app
pm2 delete guesty-calendar        # Remove from PM2
pm2 describe guesty-calendar      # Detailed info

# Monitoring
pm2 monit                         # Real-time monitor
pm2 status                        # Process status
```

#### Updating the Application
```bash
cd /opt/guesty-calendar-app

# Pull latest code
git pull origin main

# Install new dependencies (if any)
npm install

# Build TypeScript
npm run build

# Restart PM2 process
pm2 restart guesty-calendar

# Check logs for errors
pm2 logs guesty-calendar --lines 50
```

### Caddy Reverse Proxy Setup

Caddy provides automatic HTTPS with Let's Encrypt and acts as a reverse proxy to your Node.js app.

#### 1. Install Caddy
```bash
# Add Caddy repository
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list

# Install Caddy
sudo apt update
sudo apt install caddy

# Verify installation
caddy version
```

#### 2. Configure Caddy
```bash
# Create Caddyfile
sudo nano /etc/caddy/Caddyfile
```

**Basic Configuration (Single Domain):**
```caddyfile
# Replace with your domain
your-domain.com {
    # Reverse proxy to Node.js app
    reverse_proxy localhost:3005 {
        # Pass original headers
        header_up Host {host}
        header_up X-Real-IP {remote}

        # Health check
        health_uri /health
        health_interval 10s
        health_timeout 5s
    }

    # Security headers
    header {
        # Enable HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"

        # Prevent MIME sniffing
        X-Content-Type-Options "nosniff"

        # XSS protection
        X-XSS-Protection "1; mode=block"

        # Referrer policy
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Access logging
    log {
        output file /var/log/caddy/access.log {
            roll_size 10MB
            roll_keep 7
            roll_keep_for 168h
        }
        format json
    }

    # Error handling
    handle_errors {
        @502-504 expression `{err.status_code} in [502, 503, 504]`
        handle @502-504 {
            respond "Service temporarily unavailable. Please try again." 503
        }
    }
}
```

#### 3. Enable Iframe Embedding

If you need to embed the calendar in an iframe on external websites, update the security headers:

```caddyfile
your-domain.com {
    # ... (reverse_proxy config same as above)

    # Security headers with iframe support
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"

        # Allow iframe embedding from specific domains
        Content-Security-Policy "frame-ancestors 'self' https://your-main-site.com https://staging.your-site.com"

        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # ... (rest of config)
}
```

**Important:** Replace the domains in `frame-ancestors` with your actual domains where you want to embed the calendar.

#### 4. Start Caddy
```bash
# Validate configuration
sudo caddy validate --config /etc/caddy/Caddyfile

# Start Caddy service
sudo systemctl enable caddy
sudo systemctl start caddy

# Check status
sudo systemctl status caddy

# View logs
sudo journalctl -u caddy -f
```

#### 5. Reload Caddy After Config Changes
```bash
# After editing Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Firewall Configuration

#### Using UFW (Uncomplicated Firewall)
```bash
# Enable UFW
sudo ufw enable

# Allow SSH (important - do this first!)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Check status
sudo ufw status verbose

# Optional: Allow specific IPs only for SSH
sudo ufw delete allow 22/tcp
sudo ufw allow from YOUR.IP.ADDRESS to any port 22
```

### SSL/TLS Certificates

Caddy automatically obtains and renews SSL certificates from Let's Encrypt. No manual configuration needed!

**Requirements:**
- Domain must point to your server's IP address (A record)
- Ports 80 and 443 must be accessible from the internet
- Valid email in environment variable (Caddy uses it for Let's Encrypt)

**Verify SSL:**
```bash
# Check certificate
openssl s_client -connect your-domain.com:443 -servername your-domain.com < /dev/null 2>/dev/null | openssl x509 -noout -dates

# Test HTTPS
curl -I https://your-domain.com
```

### Domain Configuration

#### DNS Records
Point your domain to the server by creating an A record:

```
Type: A
Name: @ (or subdomain like "calendar")
Value: YOUR.SERVER.IP.ADDRESS
TTL: 3600 (or auto)
```

For subdomains (e.g., `guesty.example.com`):
```
Type: A
Name: guesty
Value: YOUR.SERVER.IP.ADDRESS
TTL: 3600
```

**Propagation:** DNS changes can take 1-48 hours to propagate globally. Check with:
```bash
dig your-domain.com
nslookup your-domain.com
```

### Environment Configuration for Production

Update your `.env` file with production values:

```bash
# Node Environment
NODE_ENV=production

# Server Configuration
PORT=3005
HOST=127.0.0.1  # Bind to localhost (Caddy proxies to this)
BASE_URL=https://your-domain.com

# Logging
LOG_LEVEL=info
LOG_PRETTY=false  # Use JSON logs for production

# Guesty API (from Guesty dashboard)
GUESTY_CLIENT_ID=your_client_id
GUESTY_CLIENT_SECRET=your_client_secret
GUESTY_PROPERTY_ID=your_property_id

# Booking
BOOKING_RECIPIENT_EMAIL=bookings@your-domain.com

# Authentication
SESSION_SECRET=$(openssl rand -base64 32)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
ADMIN_ALLOWED_EMAILS=admin@your-domain.com

# Cache Configuration (in minutes)
CACHE_LISTING_TTL=1440  # 24 hours
CACHE_AVAILABILITY_TTL=30  # 30 minutes
CACHE_QUOTE_TTL=60  # 60 minutes

# Database
DATABASE_PATH=./data/calendar.db
```

### Monitoring and Logs

#### Application Logs (PM2)
```bash
# Real-time logs
pm2 logs guesty-calendar

# Last 100 lines
pm2 logs guesty-calendar --lines 100

# Error logs only
pm2 logs guesty-calendar --err

# Log files location
ls -lh /home/deploy/.pm2/logs/
```

#### Caddy Logs
```bash
# Access logs
sudo tail -f /var/log/caddy/access.log

# Error logs (systemd journal)
sudo journalctl -u caddy -f

# View specific time range
sudo journalctl -u caddy --since "1 hour ago"
```

#### System Monitoring
```bash
# Check resource usage
pm2 monit

# Server resources
htop
df -h  # Disk usage
free -h  # Memory usage

# Check port bindings
sudo lsof -i -P -n | grep LISTEN
sudo ss -tulpn | grep LISTEN
```

### Health Checks

The application provides health check endpoints:

```bash
# Basic health check
curl https://your-domain.com/health

# Detailed health check
curl https://your-domain.com/health/detailed
```

Set up external monitoring (e.g., UptimeRobot, Pingdom) to monitor these endpoints.

### Backup and Restore

#### Database Backup
```bash
# Manual backup
cp /opt/guesty-calendar-app/data/calendar.db /opt/backups/calendar-$(date +%Y%m%d).db

# Automated daily backup (cron)
crontab -e
# Add this line:
0 2 * * * cp /opt/guesty-calendar-app/data/calendar.db /opt/backups/calendar-$(date +\%Y\%m\%d).db

# Restore from backup
pm2 stop guesty-calendar
cp /opt/backups/calendar-20251104.db /opt/guesty-calendar-app/data/calendar.db
pm2 start guesty-calendar
```

#### Environment File Backup
```bash
# Backup .env (contains secrets!)
cp /opt/guesty-calendar-app/.env /opt/backups/.env.backup
chmod 600 /opt/backups/.env.backup
```

### Troubleshooting

#### Application Won't Start
```bash
# Check PM2 logs
pm2 logs guesty-calendar --err

# Check if port is already in use
sudo lsof -i :3005

# Verify environment variables
pm2 env 0  # Check environment of process ID 0

# Test build manually
cd /opt/guesty-calendar-app
npm run build
node dist/index.js  # Should show error if any
```

#### SSL Certificate Issues
```bash
# Check Caddy logs
sudo journalctl -u caddy --since "10 minutes ago"

# Verify domain points to server
dig your-domain.com +short

# Test Let's Encrypt connectivity
curl -I https://acme-v02.api.letsencrypt.org/directory

# Force certificate renewal
sudo caddy reload --config /etc/caddy/Caddyfile
```

#### 502 Bad Gateway
```bash
# Check if Node.js app is running
pm2 list

# Check if app is listening on correct port
sudo lsof -i :3005

# Restart application
pm2 restart guesty-calendar

# Check application logs
pm2 logs guesty-calendar --lines 50
```

#### High Memory Usage
```bash
# Check PM2 memory
pm2 list

# Restart app to clear memory
pm2 restart guesty-calendar

# Enable PM2 auto-restart on memory limit
pm2 start dist/index.js --name guesty-calendar --max-memory-restart 500M
pm2 save
```

### Security Checklist

- [ ] Firewall enabled (UFW) with only necessary ports open
- [ ] SSH key-based authentication (disable password auth)
- [ ] Regular system updates (`sudo apt update && sudo apt upgrade`)
- [ ] Strong `SESSION_SECRET` (32+ random characters)
- [ ] `.env` file permissions set to 600 (`chmod 600 .env`)
- [ ] HTTPS enabled with valid SSL certificate
- [ ] Security headers configured in Caddy
- [ ] Regular database backups
- [ ] Monitor disk space (`df -h`)
- [ ] Monitor application logs for errors
- [ ] Keep Node.js and dependencies updated

### Production Checklist

Before going live, verify:

- [ ] Domain DNS points to server IP
- [ ] SSL certificate valid and auto-renewing
- [ ] Application starts and runs without errors
- [ ] PM2 configured to restart on boot
- [ ] Environment variables set correctly
- [ ] Google OAuth configured with production callback URL
- [ ] Admin emails whitelisted
- [ ] Health check endpoints responding
- [ ] Guesty API credentials valid
- [ ] Email booking recipient configured
- [ ] Firewall rules applied
- [ ] Log rotation configured
- [ ] Backup strategy in place
- [ ] Monitoring/alerting set up

### Deployment Workflow Summary

**Initial Setup:**
1. Set up server (user, Node.js, PM2, Caddy)
2. Configure firewall
3. Point domain to server
4. Clone repository and install dependencies
5. Configure environment variables
6. Build and start with PM2
7. Configure Caddy reverse proxy
8. Verify SSL and HTTPS working

**Subsequent Updates:**
1. SSH into server
2. `cd /opt/guesty-calendar-app`
3. `git pull origin main`
4. `npm install` (if dependencies changed)
5. `npm run build`
6. `pm2 restart guesty-calendar`
7. Check logs: `pm2 logs guesty-calendar --lines 50`
8. Verify: `curl https://your-domain.com/health`
