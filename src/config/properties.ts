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
}

/**
 * Property configuration interface
 */
export interface PropertyConfig {
  slug: string;
  provider: 'guesty' | 'hostex';
  guestyPropertyId?: string;
  hostexPropertyId?: string;
  name: string;
  timezone: string;
  currency: string;
  bookingRecipientEmail: string;
  bookingSenderName: string;
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
});

const propertyConfigSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  provider: z.enum(['guesty', 'hostex']).default('guesty'),
  guestyPropertyId: z.string().optional(),
  hostexPropertyId: z.string().optional(),
  name: z.string().min(1),
  timezone: z.string().default('Europe/Berlin'),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  bookingRecipientEmail: z.string().email(),
  bookingSenderName: z.string().min(1),
  weeklyReport: weeklyReportConfigSchema,
  ga4: ga4ConfigSchema.optional().default({ enabled: false }),
  googleCalendar: googleCalendarConfigSchema.optional().default({ enabled: false }),
  static: propertyStaticConfigSchema.optional(),
}).refine(
  (data) => {
    if (data.provider === 'guesty') return !!data.guestyPropertyId;
    if (data.provider === 'hostex') return !!data.hostexPropertyId;
    return false;
  },
  {
    message: 'guestyPropertyId is required when provider=guesty; hostexPropertyId is required when provider=hostex',
    path: ['provider'],
  }
).refine(
  (data) => {
    if (data.provider === 'hostex') return !!data.static;
    return true;
  },
  {
    message: 'static block is required when provider=hostex',
    path: ['static'],
  }
);

const propertiesFileSchema = z.object({
  properties: z.array(propertyConfigSchema).min(1, 'At least one property is required'),
});

/**
 * Cached properties configuration
 */
let cachedProperties: PropertyConfig[] | null = null;

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
export function getPropertiesByProvider(provider: 'guesty' | 'hostex'): PropertyConfig[] {
  return loadPropertiesConfig().filter((p) => p.provider === provider);
}

/**
 * Get a property by its Hostex property ID
 */
export function getPropertyByHostexId(hostexId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.hostexPropertyId === hostexId);
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
}
