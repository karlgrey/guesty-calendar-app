/**
 * Google Analytics 4 Client
 *
 * Fetches analytics data from GA4 using the Data API.
 * Requires a service account with Viewer access to the GA4 property.
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Analytics metrics for a single day
 */
export interface DailyAnalytics {
  date: string; // YYYY-MM-DD format
  pageviews: number;
  users: number;
  sessions: number;
  avgSessionDuration: number; // in seconds
}

/**
 * Top page data
 */
export interface TopPage {
  pagePath: string;
  pageTitle: string;
  pageviews: number;
}

/**
 * Analytics summary for a date range
 */
export interface AnalyticsSummary {
  startDate: string;
  endDate: string;
  totalPageviews: number;
  totalUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
  dailyData: DailyAnalytics[];
  topPages: TopPage[];
}

/**
 * GA4 Analytics Client
 */
class GA4Client {
  private client: BetaAnalyticsDataClient | null = null;
  private propertyId: string;

  constructor() {
    this.propertyId = config.ga4PropertyId || '';
  }

  /**
   * Initialize the GA4 client with service account credentials
   */
  private getClient(): BetaAnalyticsDataClient {
    if (this.client) {
      return this.client;
    }

    if (!config.ga4Enabled) {
      throw new Error('GA4 analytics is not enabled');
    }

    if (!config.ga4PropertyId) {
      throw new Error('GA4_PROPERTY_ID is not configured');
    }

    if (!config.ga4KeyFilePath) {
      throw new Error('GA4_KEY_FILE_PATH is not configured');
    }

    // Resolve the key file path (relative to project root)
    let keyFilePath = config.ga4KeyFilePath;
    if (!path.isAbsolute(keyFilePath)) {
      keyFilePath = path.resolve(__dirname, '../../', keyFilePath);
    }

    logger.debug({ keyFilePath }, 'Initializing GA4 client');

    this.client = new BetaAnalyticsDataClient({
      keyFilename: keyFilePath,
    });

    return this.client;
  }

  /**
   * Check if GA4 is enabled and properly configured
   */
  isEnabled(): boolean {
    return !!(config.ga4Enabled && config.ga4PropertyId && config.ga4KeyFilePath);
  }

  /**
   * Fetch analytics data for the last N days
   *
   * @param days Number of days to fetch (default: 30)
   */
  async getAnalytics(days: number = 30): Promise<AnalyticsSummary> {
    const client = this.getClient();

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    logger.info({ startDate: startDateStr, endDate: endDateStr, days }, 'Fetching GA4 analytics data');

    // Fetch daily metrics
    const [dailyResponse] = await client.runReport({
      property: `properties/${this.propertyId}`,
      dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'averageSessionDuration' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    });

    // Parse daily data
    const dailyData: DailyAnalytics[] = [];
    let totalPageviews = 0;
    let totalUsers = 0;
    let totalSessions = 0;
    let totalDuration = 0;

    if (dailyResponse.rows) {
      for (const row of dailyResponse.rows) {
        const dateRaw = row.dimensionValues?.[0]?.value || '';
        // Convert from YYYYMMDD to YYYY-MM-DD
        const date = dateRaw.length === 8
          ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
          : dateRaw;

        const pageviews = parseInt(row.metricValues?.[0]?.value || '0', 10);
        const users = parseInt(row.metricValues?.[1]?.value || '0', 10);
        const sessions = parseInt(row.metricValues?.[2]?.value || '0', 10);
        const avgSessionDuration = parseFloat(row.metricValues?.[3]?.value || '0');

        dailyData.push({
          date,
          pageviews,
          users,
          sessions,
          avgSessionDuration,
        });

        totalPageviews += pageviews;
        totalUsers += users;
        totalSessions += sessions;
        totalDuration += avgSessionDuration * sessions;
      }
    }

    // Fetch top pages
    const [topPagesResponse] = await client.runReport({
      property: `properties/${this.propertyId}`,
      dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
      dimensions: [
        { name: 'pagePath' },
        { name: 'pageTitle' },
      ],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
    });

    // Parse top pages
    const topPages: TopPage[] = [];
    if (topPagesResponse.rows) {
      for (const row of topPagesResponse.rows) {
        topPages.push({
          pagePath: row.dimensionValues?.[0]?.value || '',
          pageTitle: row.dimensionValues?.[1]?.value || '',
          pageviews: parseInt(row.metricValues?.[0]?.value || '0', 10),
        });
      }
    }

    const avgSessionDuration = totalSessions > 0 ? totalDuration / totalSessions : 0;

    logger.info(
      {
        totalPageviews,
        totalUsers,
        totalSessions,
        avgSessionDuration: Math.round(avgSessionDuration),
        daysWithData: dailyData.length,
        topPagesCount: topPages.length,
      },
      'GA4 analytics data fetched successfully'
    );

    return {
      startDate: startDateStr,
      endDate: endDateStr,
      totalPageviews,
      totalUsers,
      totalSessions,
      avgSessionDuration,
      dailyData,
      topPages,
    };
  }

  /**
   * Test the connection to GA4
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.isEnabled()) {
        return { success: false, error: 'GA4 is not enabled or not properly configured' };
      }

      // Try to fetch 1 day of data to verify connection
      await this.getAnalytics(1);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, 'GA4 connection test failed');
      return { success: false, error: message };
    }
  }
}

// Export singleton instance
export const ga4Client = new GA4Client();
