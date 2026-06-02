/**
 * Multi-Property Configuration Module
 *
 * Loads property configuration from JSON file and provides helper functions
 * for property lookup by slug or Guesty ID.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import logger from '../utils/logger.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * GA4 configuration for a property
 */
export interface GA4Config {
  enabled: boolean;
  propertyId?: string;
  keyFilePath?: string;
  syncHour?: number;
}

/**
 * Google Calendar configuration for a property
 */
export interface GoogleCalendarConfig {
  enabled: boolean;
  calendarId?: string;
  checkInTime?: string;  // e.g. "16:00"
  checkOutTime?: string; // e.g. "12:00"
}

/**
 * Weekly report configuration for a property
 */
export interface WeeklyReportConfig {
  enabled: boolean;
  recipients: string[];
  day: number; // 0 = Sunday, 1 = Monday, etc.
  hour: number; // 0-23
}

/**
 * Portfolio BI report configuration (top-level, not per-property).
 */
export interface BiReportConfig {
  enabled: boolean;
  recipients: string[];
  day: number;   // 0 = Sunday, 1 = Monday, ...
  hour: number;  // 0-23
  timezone: string;
  forecastHorizonMonths: number;
}

/**
 * Static config for hostex providers — fills fields Hostex API doesn't expose.
 */
export interface PropertyStaticConfig {
  accommodates: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  propertyType?: string | null;
  extraPersonFee?: number;
  guestsIncluded?: number;
  weeklyPriceFactor?: number;
  monthlyPriceFactor?: number;
  taxes?: Array<{
    type: string;
    amount: number;
    units: 'PERCENTAGE' | 'FIXED';
    quantifier: 'PER_NIGHT' | 'PER_STAY' | 'PER_GUEST' | 'PER_GUEST_PER_NIGHT';
    appliedToAllFees?: boolean;
    appliedOnFees?: string[];
  }>;
  basePrice?: number | null;
  cleaningFee?: number | null;
  minNights?: number | null;
  maxNights?: number | null;
  // Effective-payout deductions (airbnb-mail provider, default 0 for all others).
  // Co-host share applies to (host_payout − cleaning_fee).
  // Income tax applies to (total_price − occupancy_tax).
  coHostShareRate?: number;
  incomeTaxRate?: number;
}

/**
 * Property configuration interface
 */
export interface PropertyConfig {
  slug: string;
  provider: 'guesty' | 'hostex' | 'airbnb-mail';
  guestyPropertyId?: string;
  hostexPropertyId?: string;
  airbnbListingId?: string;
  airbnbIcalUrl?: string;
  airbnbMailLabel?: string;
  // Gmail label that collects ALL direct-booking correspondence for this property
  // (booking@…, mic@…). Filter out Airbnb at sync time. Optional — only properties
  // with this set will have direct-email sync.
  directEmailLabel?: string;
  name: string;
  timezone: string;
  currency: string;
  bookingRecipientEmail: string;
  bookingSenderName: string;
  /** Kanonische öffentliche Website der Unterkunft, z.B. "https://farmhouse-prasser.de".
   *  Wird in der generierten Anfragemail als Absender-/Unterkunfts-Link verwendet. */
  website?: string;
  weeklyReport: WeeklyReportConfig;
  ga4?: GA4Config;
  googleCalendar?: GoogleCalendarConfig;
  static?: PropertyStaticConfig;
}

/**
 * Zod schema for property validation
 */
const ga4ConfigSchema = z.object({
  enabled: z.boolean(),
  propertyId: z.string().optional(),
  keyFilePath: z.string().optional(),
  syncHour: z.number().int().min(0).max(23).optional(),
});

const googleCalendarConfigSchema = z.object({
  enabled: z.boolean(),
  calendarId: z.string().optional(),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const weeklyReportConfigSchema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().email()),
  day: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
});

const biReportConfigSchema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().email()),
  day: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  timezone: z.string().default('Europe/Berlin'),
  forecastHorizonMonths: z.number().int().min(1).max(12).default(6),
});

/**
 * Validate a raw biReport block. Returns undefined when the block is absent.
 * Exported for unit testing.
 */
export function parseBiReportConfig(raw: unknown): BiReportConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  return biReportConfigSchema.parse(raw);
}

const taxConfigSchema = z.object({
  type: z.string(),
  amount: z.number(),
  units: z.enum(['PERCENTAGE', 'FIXED']),
  quantifier: z.enum(['PER_NIGHT', 'PER_STAY', 'PER_GUEST', 'PER_GUEST_PER_NIGHT']),
  appliedToAllFees: z.boolean().optional(),
  appliedOnFees: z.array(z.string()).optional(),
});

const propertyStaticConfigSchema = z.object({
  accommodates: z.number().int().min(1, 'static.accommodates is required and must be >= 1'),
  bedrooms: z.number().int().min(0).nullable().optional(),
  bathrooms: z.number().min(0).nullable().optional(),
  propertyType: z.string().nullable().optional(),
  extraPersonFee: z.number().min(0).optional(),
  guestsIncluded: z.number().int().min(1).optional(),
  weeklyPriceFactor: z.number().positive().optional(),
  monthlyPriceFactor: z.number().positive().optional(),
  taxes: z.array(taxConfigSchema).optional(),
  basePrice: z.number().nullable().optional(),
  cleaningFee: z.number().nullable().optional(),
  minNights: z.number().int().min(1).nullable().optional(),
  maxNights: z.number().int().min(1).nullable().optional(),
  coHostShareRate: z.number().min(0).max(1).optional(),
  incomeTaxRate: z.number().min(0).max(1).optional(),
});

const propertyConfigSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  provider: z.enum(['guesty', 'hostex', 'airbnb-mail']).default('guesty'),
  guestyPropertyId: z.string().optional(),
  hostexPropertyId: z.string().optional(),
  airbnbListingId: z.string().optional(),
  airbnbIcalUrl: z.string().url().optional(),
  airbnbMailLabel: z.string().optional(),
  directEmailLabel: z.string().optional(),
  name: z.string().min(1),
  timezone: z.string().default('Europe/Berlin'),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  bookingRecipientEmail: z.string().email(),
  bookingSenderName: z.string().min(1),
  website: z.string().url().optional(),
  weeklyReport: weeklyReportConfigSchema,
  ga4: ga4ConfigSchema.optional().default({ enabled: false }),
  googleCalendar: googleCalendarConfigSchema.optional().default({ enabled: false }),
  static: propertyStaticConfigSchema.optional(),
}).refine(
  (data) => {
    if (data.provider === 'guesty') return !!data.guestyPropertyId;
    if (data.provider === 'hostex') return !!data.hostexPropertyId;
    if (data.provider === 'airbnb-mail') return !!data.airbnbListingId && !!data.airbnbIcalUrl;
    return false;
  },
  {
    message: 'guestyPropertyId required for provider=guesty; hostexPropertyId for provider=hostex; airbnbListingId + airbnbIcalUrl for provider=airbnb-mail',
    path: ['provider'],
  }
).refine(
  (data) => {
    if (data.provider === 'hostex' || data.provider === 'airbnb-mail') return !!data.static;
    return true;
  },
  {
    message: 'static block is required when provider=hostex or provider=airbnb-mail',
    path: ['static'],
  }
);

const propertiesFileSchema = z.object({
  properties: z.array(propertyConfigSchema).min(1, 'At least one property is required'),
  biReport: biReportConfigSchema.optional(),
});

/**
 * Cached properties configuration
 */
let cachedProperties: PropertyConfig[] | null = null;
let cachedBiReport: BiReportConfig | null | undefined = undefined; // undefined = not loaded yet

/**
 * Get the path to the properties config file
 */
function getPropertiesConfigPath(): string {
  const envPath = process.env.PROPERTIES_CONFIG_PATH;
  if (envPath) {
    if (path.isAbsolute(envPath)) {
      return envPath;
    }
    // Resolve relative to project root
    return path.resolve(__dirname, '../../', envPath);
  }
  // Default path
  return path.resolve(__dirname, '../../data/properties.json');
}

/**
 * Load and validate properties configuration from JSON file
 */
export function loadPropertiesConfig(): PropertyConfig[] {
  if (cachedProperties) {
    return cachedProperties;
  }

  const configPath = getPropertiesConfigPath();

  // Check if file exists
  if (!existsSync(configPath)) {
    logger.warn(
      { configPath },
      'Properties config file not found, falling back to single property mode'
    );
    return [];
  }

  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(fileContent);
    const validatedConfig = propertiesFileSchema.parse(rawConfig);

    cachedProperties = validatedConfig.properties;
    cachedBiReport = validatedConfig.biReport ?? null;

    logger.info(
      {
        configPath,
        propertyCount: cachedProperties.length,
        properties: cachedProperties.map((p) => ({ slug: p.slug, name: p.name })),
      },
      'Loaded properties configuration'
    );

    return cachedProperties;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error(
        {
          configPath,
          errors: error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        'Properties config validation failed'
      );
    } else if (error instanceof SyntaxError) {
      logger.error({ configPath, error: error.message }, 'Properties config JSON parse error');
    } else {
      logger.error({ configPath, error }, 'Failed to load properties config');
    }
    throw error;
  }
}

/**
 * Get a property by its URL slug
 */
export function getPropertyBySlug(slug: string): PropertyConfig | undefined {
  const properties = loadPropertiesConfig();
  return properties.find((p) => p.slug === slug);
}

/**
 * Get a property by its Guesty listing ID
 */
export function getPropertyByGuestyId(guestyId: string): PropertyConfig | undefined {
  const properties = loadPropertiesConfig();
  return properties.find((p) => p.guestyPropertyId === guestyId);
}

/**
 * Get all properties for a specific provider
 */
export function getPropertiesByProvider(provider: 'guesty' | 'hostex' | 'airbnb-mail'): PropertyConfig[] {
  return loadPropertiesConfig().filter((p) => p.provider === provider);
}

/**
 * Get a property by its Hostex property ID
 */
export function getPropertyByHostexId(hostexId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.hostexPropertyId === hostexId);
}

/**
 * Get a property by its Airbnb listing ID
 */
export function getPropertyByAirbnbId(airbnbId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.airbnbListingId === airbnbId);
}

/**
 * Get the provider-specific listing ID. Use this anywhere code needs the
 * database listing_id from a PropertyConfig, regardless of provider.
 * Throws if neither ID is set — schema validation should have caught this earlier.
 */
export function getListingId(property: PropertyConfig): string {
  if (property.provider === 'hostex') {
    if (!property.hostexPropertyId) throw new Error(`Hostex property ${property.slug} missing hostexPropertyId`);
    return property.hostexPropertyId;
  }
  if (property.provider === 'airbnb-mail') {
    if (!property.airbnbListingId) throw new Error(`Airbnb-mail property ${property.slug} missing airbnbListingId`);
    return property.airbnbListingId;
  }
  if (!property.guestyPropertyId) throw new Error(`Guesty property ${property.slug} missing guestyPropertyId`);
  return property.guestyPropertyId;
}

/**
 * Get all configured properties
 */
export function getAllProperties(): PropertyConfig[] {
  return loadPropertiesConfig();
}

/**
 * Get the default property (first in the list)
 */
export function getDefaultProperty(): PropertyConfig | undefined {
  const properties = loadPropertiesConfig();
  return properties[0];
}

/**
 * Get the portfolio BI report config, or undefined if not configured.
 */
export function getBiReportConfig(): BiReportConfig | undefined {
  loadPropertiesConfig();
  return cachedBiReport ?? undefined;
}

/**
 * Get property slugs as an array
 */
export function getPropertySlugs(): string[] {
  const properties = loadPropertiesConfig();
  return properties.map((p) => p.slug);
}

/**
 * Check if multi-property mode is enabled (more than one property configured)
 */
export function isMultiPropertyMode(): boolean {
  const properties = loadPropertiesConfig();
  return properties.length > 1;
}

/**
 * Clear cached properties (useful for testing or hot-reload)
 */
export function clearPropertiesCache(): void {
  cachedProperties = null;
  cachedBiReport = undefined;
}
