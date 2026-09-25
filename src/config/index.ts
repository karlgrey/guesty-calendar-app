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
  guestyPropertyId: z.string().optional(), // Optional - falls back to properties.json
  propertiesConfigPath: z.string().default('./data/properties.json'),
  vaultPath: z.string().optional(),
  agentApiKey: z.string().min(32, 'AGENT_API_KEY must be at least 32 characters').optional(),
  // Zusätzliche Agent-Keys, kommagetrennt (Whitespace toleriert) — Vereinigungsmenge mit
  // AGENT_API_KEY, z. B. für einen separaten Key pro Client (labs). Jeder Eintrag muss
  // dieselbe Mindestlänge wie AGENT_API_KEY erfüllen.
  agentApiKeys: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val.split(',').map((key) => key.trim()).filter((key) => key.length > 0)
        : []
    )
    .refine((keys) => keys.every((key) => key.length >= 32), {
      message: 'Each entry in AGENT_API_KEYS must be at least 32 characters',
    }),

  // Hostex API (optional — only required if hostex-provider properties exist)
  hostexAccessToken: z.string().optional(),
  hostexApiUrl: z.string().url().default('https://api.hostex.io/v3'),

  // Airbnb-Mail integration (optional — only required if airbnb-mail providers exist)
  airbnbMailHost: z.string().optional(),
  airbnbMailPort: z.coerce.number().int().min(1).max(65535).default(993),
  airbnbMailUser: z.string().optional(),
  airbnbMailPassword: z.string().optional(),
  // Staleness alarm (#327): flag airbnb-mail properties whose last successful
  // sync is older than this — catches a silently broken IMAP login that #324
  // (per-mail error isolation) would not (it prevents wedging, not silence).
  airbnbMailStalenessThresholdHours: z.coerce.number().int().min(1).default(26),

  // Kalender-Konsistenz-Check (#484): Empfänger der täglichen Alert-Mail bei
  // Befund (Diff und/oder überfällige Holds). Ohne Wert: kein Mailversand,
  // stattdessen logger.error (Muster check-staleness.ts).
  consistencyAlertRecipients: z.string().optional().transform((val) =>
    val ? val.split(',').map((email) => email.trim()).filter((email) => email.length > 0) : []
  ),

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

  // Email Configuration (Resend or SMTP)
  resendApiKey: z.string().optional(),
  emailFromAddress: z.string().email().optional(),
  emailFromName: z.string().default('Guesty Calendar'),
  // Dev-only safety net: when set and NODE_ENV !== production, ALL outgoing mail is
  // redirected to this single address (so local test/report sends never reach real recipients).
  devEmailOverride: z.string().email().optional(),

  // SMTP (fallback if Resend not configured)
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.string().optional().transform((val) => {
    if (val === undefined || val === null) return true;
    const lower = String(val).toLowerCase();
    return lower !== 'false' && lower !== '0' && lower !== 'no';
  }),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  weeklyReportEnabled: z.string().optional().transform((val) => {
    if (!val) return false;
    const lower = String(val).toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }),
  weeklyReportRecipients: z.string().optional().transform((val) =>
    val ? val.split(',').map(email => email.trim()) : []
  ),
  weeklyReportDay: z.coerce.number().int().min(0).max(6).default(1), // 0 = Sunday, 1 = Monday, etc.
  weeklyReportHour: z.coerce.number().int().min(0).max(23).default(9), // 9 AM

  // Google Analytics 4 Configuration
  ga4PropertyId: z.string().optional(),
  ga4KeyFilePath: z.string().optional(),
  ga4Enabled: z.string().optional().transform((val) => {
    if (!val) return false;
    const lower = String(val).toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }),
  ga4SyncHour: z.coerce.number().int().min(0).max(23).default(3), // 3 AM daily sync

  // Anthropic API (optional — only required when running the LLM classify script)
  anthropicApiKey: z.string().optional(),

  // Auto-Send-Gate (Spec 2026-09-19)
  autoSendMode: z.enum(['off', 'shadow', 'live']).default('off'),
  autoSendDailyCap: z.coerce.number().int().min(0).default(10),
  messageLoopMinutes: z.coerce.number().int().min(1).default(5),
  guestyWebhookSecret: z.string().optional(),
  judgeModel: z.string().default('claude-opus-5'),

  // Stale-Draft-Regeneration (#699): ein KI-Entwurf, der beim Öffnen im Admin-UI älter als
  // diese Schwelle ist, wird still neu generiert (stale-draft-regen.ts).
  draftStaleHours: z.coerce.number().positive().default(6),

  // SmartTasks-Client (#696): eigener API-Key "guesty-app", nur Task-Anlage/-Kommentare,
  // keine Wiki-/Vault-Rechte (Kernschutz). Ausfall der API darf den Versand nie blockieren —
  // siehe promise-task-service.ts.
  smartTasksApiKey: z.string().optional(),
  smartTasksApiUrl: z.string().url().default('https://tasks.remoterepublic.com/api'),
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
    propertiesConfigPath: process.env.PROPERTIES_CONFIG_PATH,
    vaultPath: process.env.VAULT_PATH,
    agentApiKey: process.env.AGENT_API_KEY,
    agentApiKeys: process.env.AGENT_API_KEYS,
    hostexAccessToken: process.env.HOSTEX_ACCESS_TOKEN,
    hostexApiUrl: process.env.HOSTEX_API_URL,
    airbnbMailHost: process.env.AIRBNB_MAIL_HOST,
    airbnbMailPort: process.env.AIRBNB_MAIL_PORT,
    airbnbMailUser: process.env.AIRBNB_MAIL_USER,
    airbnbMailPassword: process.env.AIRBNB_MAIL_PASSWORD,
    airbnbMailStalenessThresholdHours: process.env.AIRBNB_MAIL_STALENESS_THRESHOLD_HOURS,
    consistencyAlertRecipients: process.env.CONSISTENCY_ALERT_RECIPIENTS,
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
    resendApiKey: process.env.RESEND_API_KEY,
    emailFromAddress: process.env.EMAIL_FROM_ADDRESS,
    emailFromName: process.env.EMAIL_FROM_NAME,
    devEmailOverride: process.env.DEV_EMAIL_OVERRIDE,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpSecure: process.env.SMTP_SECURE,
    smtpUser: process.env.SMTP_USER,
    smtpPassword: process.env.SMTP_PASSWORD,
    weeklyReportEnabled: process.env.WEEKLY_REPORT_ENABLED,
    weeklyReportRecipients: process.env.WEEKLY_REPORT_RECIPIENTS,
    weeklyReportDay: process.env.WEEKLY_REPORT_DAY,
    weeklyReportHour: process.env.WEEKLY_REPORT_HOUR,
    ga4PropertyId: process.env.GA4_PROPERTY_ID,
    ga4KeyFilePath: process.env.GA4_KEY_FILE_PATH,
    ga4Enabled: process.env.GA4_ENABLED,
    ga4SyncHour: process.env.GA4_SYNC_HOUR,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    autoSendMode: process.env.AUTO_SEND_MODE,
    autoSendDailyCap: process.env.AUTO_SEND_DAILY_CAP,
    messageLoopMinutes: process.env.MESSAGE_LOOP_MINUTES,
    guestyWebhookSecret: process.env.GUESTY_WEBHOOK_SECRET,
    judgeModel: process.env.JUDGE_MODEL,
    draftStaleHours: process.env.DRAFT_STALE_HOURS,
    smartTasksApiKey: process.env.SMARTTASKS_API_KEY,
    smartTasksApiUrl: process.env.SMARTTASKS_API_URL,
  };

  try {
    const parsed = configSchema.parse(rawConfig);
    // Vereinigungsmenge aus AGENT_API_KEY (Legacy-Einzelwert) + AGENT_API_KEYS (Liste),
    // dedupliziert — das ist die einzige Quelle, die die Agent-Key-Middleware konsultiert.
    const agentApiKeySet = Array.from(
      new Set([
        ...(parsed.agentApiKey ? [parsed.agentApiKey] : []),
        ...parsed.agentApiKeys,
      ])
    );
    return { ...parsed, agentApiKeySet };
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
export type Config = z.infer<typeof configSchema> & { agentApiKeySet: string[] };

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