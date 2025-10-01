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

  // Cache TTLs (in hours)
  cacheListingTtl: z.coerce.number().int().min(1).default(24),
  cacheAvailabilityTtl: z.coerce.number().int().min(1).default(1),
  cacheQuoteTtl: z.coerce.number().int().min(1).default(1),

  // Database
  databasePath: z.string().default('./data/calendar.db'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  logPretty: z.coerce.boolean().default(true),
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