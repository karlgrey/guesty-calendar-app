/**
 * Guesty API Client
 *
 * Handles all communication with the Guesty Open API.
 */

import { config } from '../config/index.js';
import { ExternalApiError } from '../utils/errors.js';
import { logApiCall } from '../utils/logger.js';
import logger from '../utils/logger.js';
import type { GuestyListing, GuestyCalendarResponse } from '../types/guesty.js';

/**
 * OAuth Token Response
 */
interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Guesty API Client with OAuth 2.0 authentication
 */
export class GuestyClient {
  private readonly baseUrl: string;
  private readonly oauthUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  private accessToken: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(
    baseUrl: string = config.guestyApiUrl,
    oauthUrl: string = config.guestyOAuthUrl,
    clientId: string = config.guestyClientId,
    clientSecret: string = config.guestyClientSecret
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.oauthUrl = oauthUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Exchange client credentials for access token
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 5 minute buffer)
    if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }

    logger.info('Fetching new OAuth access token from Guesty');

    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'open-api',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      const response = await fetch(this.oauthUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ExternalApiError(
          `OAuth token exchange failed: ${response.status} ${response.statusText}`,
          response.status,
          'Guesty OAuth',
          { error: errorText }
        );
      }

      const tokenData = await response.json() as OAuthTokenResponse;
      this.accessToken = tokenData.access_token;
      // Token valid for 24 hours, cache until expiry
      this.tokenExpiresAt = Date.now() + (tokenData.expires_in * 1000);

      logger.info({
        expiresIn: tokenData.expires_in,
        expiresAt: new Date(this.tokenExpiresAt).toISOString(),
      }, 'Successfully obtained OAuth access token');

      return this.accessToken;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }
      throw new ExternalApiError(
        `Failed to obtain OAuth token: ${error instanceof Error ? error.message : 'Unknown error'}`,
        502,
        'Guesty OAuth',
        { originalError: error }
      );
    }
  }

  /**
   * Make authenticated request to Guesty API
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();

    // Get fresh access token (uses cached token if still valid)
    const accessToken = await this.getAccessToken();

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const duration = Date.now() - startTime;
      logApiCall('Guesty', endpoint, response.status, duration);

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }

        throw new ExternalApiError(
          `Guesty API error: ${response.status} ${response.statusText}`,
          response.status,
          'Guesty',
          errorData
        );
      }

      return await response.json() as T;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof ExternalApiError) {
        throw error;
      }

      // Network or parsing error
      logApiCall('Guesty', endpoint, 0, duration);
      throw new ExternalApiError(
        `Failed to communicate with Guesty API: ${error instanceof Error ? error.message : 'Unknown error'}`,
        502,
        'Guesty',
        { originalError: error }
      );
    }
  }

  /**
   * Fetch listing details by ID
   */
  async getListing(listingId: string): Promise<GuestyListing> {
    logger.debug({ listingId }, 'Fetching listing from Guesty API');

    const listing = await this.request<GuestyListing>(`/listings/${listingId}`);

    logger.debug({ listingId, title: listing.title }, 'Listing fetched successfully');

    return listing;
  }

  /**
   * Fetch calendar availability for a date range
   */
  async getCalendar(listingId: string, startDate: string, endDate: string): Promise<GuestyCalendarResponse> {
    logger.debug({ listingId, startDate, endDate }, 'Fetching calendar from Guesty API');

    // Guesty calendar endpoint expects query parameters
    const queryParams = new URLSearchParams({
      startDate,
      endDate,
    });

    const response = await this.request<{ status: number; data: { days: GuestyCalendarResponse } }>(
      `/availability-pricing/api/calendar/listings/${listingId}?${queryParams}`
    );

    // Unwrap the response - API returns { status, data: { days: [...] } }
    const calendar = response.data.days;

    logger.debug(
      { listingId, startDate, endDate, daysCount: calendar.length },
      'Calendar fetched successfully'
    );

    return calendar;
  }

  /**
   * Fetch 12 months of availability starting from today
   */
  async get12MonthsCalendar(listingId: string): Promise<GuestyCalendarResponse> {
    const today = new Date();
    const startDate = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // Calculate end date (12 months ahead)
    const endDate = new Date(today);
    endDate.setMonth(endDate.getMonth() + 12);
    const endDateStr = endDate.toISOString().split('T')[0];

    logger.info({ listingId, startDate, endDate: endDateStr }, 'Fetching 12 months of calendar data');

    return this.getCalendar(listingId, startDate, endDateStr);
  }

  /**
   * Health check: verify API credentials and connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Try to fetch the configured property to verify access
      await this.getListing(config.guestyPropertyId);
      return true;
    } catch (error) {
      logger.error({ error }, 'Guesty API health check failed');
      return false;
    }
  }
}

/**
 * Default Guesty client instance (singleton)
 */
export const guestyClient = new GuestyClient();