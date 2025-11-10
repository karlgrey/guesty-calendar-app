/**
 * Configuration Module
 *
 * Loads and validates configuration from environment variables using Zod.
 * Provides type-safe access to all application settings.
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file
loadEnv();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Configuration schema with validation
 */
const configSchema = z.object({
  // Node environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Server
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default('localhost'),

  // Guesty API
  guestyClientId: z.string().min(1, 'GUESTY_CLIENT_ID is required'),
  guestyClientSecret: z.string().min(1, 'GUESTY_CLIENT_SECRET is required'),
  guestyApiUrl: z.string().url().default('https://open-api.guesty.com/v1'),
  guestyOAuthUrl: z.string().url().default('https://open-api.guesty.com/oauth2/token'),
  guestyPropertyId: z.string().min(1, 'GUESTY_PROPERTY_ID is required'),

  // Property
  propertyCurrency: z.string().length(3).toUpperCase().default('EUR'),
  propertyTimezone: z.string().default('Europe/Berlin'),

  // Booking
  bookingRecipientEmail: z.string().email('Invalid booking recipient email'),
  bookingSenderName: z.string().default('Farmhouse Prasser'),

  // Cache TTLs (in minutes)
  // Availability TTL controls ETL scheduler interval - must balance freshness vs. rate limits
  cacheListingTtl: z.coerce.number().int().min(1).default(1440), // 24 hours
  cacheAvailabilityTtl: z.coerce.number().int().min(1).default(60), // 60 minutes (avoids rate limiting)
  cacheQuoteTtl: z.coerce.number().int().min(1).default(60), // 1 hour

  // Database
  databasePath: z.string().default('./data/calendar.db'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  logPretty: z.coerce.boolean().default(true),

  // Authentication
  baseUrl: z.string().url('BASE_URL must be a valid URL'),
  sessionSecret: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  googleClientId: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  googleClientSecret: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  adminAllowedEmails: z.string().min(1, 'ADMIN_ALLOWED_EMAILS is required').transform((val) =>
    val.split(',').map(email => email.trim().toLowerCase())
  ),

  // Email / SMTP
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.coerce.boolean().default(true),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFromEmail: z.string().email().optional(),
  smtpFromName: z.string().default('Guesty Calendar'),
  weeklyReportEnabled: z.coerce.boolean().default(false),
  weeklyReportRecipients: z.string().optional().transform((val) =>
    val ? val.split(',').map(email => email.trim()) : []
  ),
  weeklyReportDay: z.coerce.number().int().min(0).max(6).default(1), // 0 = Sunday, 1 = Monday, etc.
  weeklyReportHour: z.coerce.number().int().min(0).max(23).default(9), // 9 AM
});

/**
 * Parse and validate configuration
 */
function parseConfig() {
  const rawConfig = {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    host: process.env.HOST,
    guestyClientId: process.env.GUESTY_CLIENT_ID,
    guestyClientSecret: process.env.GUESTY_CLIENT_SECRET,
    guestyApiUrl: process.env.GUESTY_API_URL,
    guestyOAuthUrl: process.env.GUESTY_OAUTH_URL,
    guestyPropertyId: process.env.GUESTY_PROPERTY_ID,
    propertyCurrency: process.env.PROPERTY_CURRENCY,
    propertyTimezone: process.env.PROPERTY_TIMEZONE,
    bookingRecipientEmail: process.env.BOOKING_RECIPIENT_EMAIL,
    bookingSenderName: process.env.BOOKING_SENDER_NAME,
    cacheListingTtl: process.env.CACHE_LISTING_TTL,
    cacheAvailabilityTtl: process.env.CACHE_AVAILABILITY_TTL,
    cacheQuoteTtl: process.env.CACHE_QUOTE_TTL,
    databasePath: process.env.DATABASE_PATH,
    logLevel: process.env.LOG_LEVEL,
    logPretty: process.env.LOG_PRETTY,
    baseUrl: process.env.BASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    adminAllowedEmails: process.env.ADMIN_ALLOWED_EMAILS,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpSecure: process.env.SMTP_SECURE,
    smtpUser: process.env.SMTP_USER,
    smtpPassword: process.env.SMTP_PASSWORD,
    smtpFromEmail: process.env.SMTP_FROM_EMAIL,
    smtpFromName: process.env.SMTP_FROM_NAME,
    weeklyReportEnabled: process.env.WEEKLY_REPORT_ENABLED,
    weeklyReportRecipients: process.env.WEEKLY_REPORT_RECIPIENTS,
    weeklyReportDay: process.env.WEEKLY_REPORT_DAY,
    weeklyReportHour: process.env.WEEKLY_REPORT_HOUR,
  };

  try {
    return configSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Configuration validation failed:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      console.error('\nPlease check your .env file and ensure all required variables are set.');
      console.error('See .env.example for reference.\n');
    }
    throw error;
  }
}

/**
 * Application configuration (singleton)
 */
export const config = parseConfig();

/**
 * Configuration type (inferred from schema)
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Check if running in development mode
 */
export const isDevelopment = config.nodeEnv === 'development';

/**
 * Check if running in production mode
 */
export const isProduction = config.nodeEnv === 'production';

/**
 * Check if running in test mode
 */
export const isTest = config.nodeEnv === 'test';

/**
 * Resolve database path (ensure it's absolute)
 */
export function getDatabasePath(): string {
  if (path.isAbsolute(config.databasePath)) {
    return config.databasePath;
  }
  // Resolve relative to project root (two levels up from src/config)
  return path.resolve(__dirname, '../../', config.databasePath);
}