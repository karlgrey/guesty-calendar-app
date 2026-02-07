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
 * Property configuration interface
 */
export interface PropertyConfig {
  slug: string;
  guestyPropertyId: string;
  name: string;
  timezone: string;
  currency: string;
  bookingRecipientEmail: string;
  bookingSenderName: string;
  weeklyReport: WeeklyReportConfig;
  ga4?: GA4Config;
  googleCalendar?: GoogleCalendarConfig;
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
});

const weeklyReportConfigSchema = z.object({
  enabled: z.boolean(),
  recipients: z.array(z.string().email()),
  day: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
});

const propertyConfigSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  guestyPropertyId: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().default('Europe/Berlin'),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  bookingRecipientEmail: z.string().email(),
  bookingSenderName: z.string().min(1),
  weeklyReport: weeklyReportConfigSchema,
  ga4: ga4ConfigSchema.optional().default({ enabled: false }),
  googleCalendar: googleCalendarConfigSchema.optional().default({ enabled: false }),
});

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
