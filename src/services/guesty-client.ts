/**
 * Guesty API Client
 *
 * Handles all communication with the Guesty Open API with rate limit handling.
 */

import Bottleneck from 'bottleneck';
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
 * Rate limit tracking
 */
interface RateLimitInfo {
  limitPerSecond: number | null;
  remainingPerSecond: number | null;
  limitPerMinute: number | null;
  remainingPerMinute: number | null;
  limitPerHour: number | null;
  remainingPerHour: number | null;
}

/**
 * Sleep utility for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Guesty API Client with OAuth 2.0 authentication and rate limit handling
 */
export class GuestyClient {
  private readonly baseUrl: string;
  private readonly oauthUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  private accessToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private rateLimitInfo: RateLimitInfo = {
    limitPerSecond: null,
    remainingPerSecond: null,
    limitPerMinute: null,
    remainingPerMinute: null,
    limitPerHour: null,
    remainingPerHour: null,
  };

  // Request queue to prevent exceeding rate limits
  // Guesty limits: 15 req/sec, 120 req/min, 5000 req/hour, max 15 concurrent
  private limiter: Bottleneck;

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

    // Configure rate limiter
    // Conservative limits: 10 req/sec (buffer below 15), 10 concurrent (buffer below 15)
    this.limiter = new Bottleneck({
      reservoir: 10, // Initial capacity
      reservoirRefreshAmount: 10, // Refill amount
      reservoirRefreshInterval: 1000, // Refill every 1 second (10 req/sec)
      maxConcurrent: 10, // Max 10 concurrent requests (below 15 limit)
      minTime: 100, // Minimum 100ms between requests (10 req/sec)
    });

    // Log rate limiter events
    this.limiter.on('failed', async (error, jobInfo) => {
      logger.warn({ error, jobInfo }, 'Request failed in rate limiter');
    });

    this.limiter.on('depleted', () => {
      logger.debug('Rate limiter reservoir depleted, requests will be queued');
    });
  }

  /**
   * Exchange client credentials for access token with retry logic
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 5 minute buffer)
    if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }

    logger.info('Fetching new OAuth access token from Guesty');

    const maxRetries = 5; // More retries for OAuth since it's critical
    let lastError: Error | ExternalApiError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

        // Handle 429 Rate Limit with retry
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          let delayMs: number;

          if (retryAfterHeader) {
            // Retry-After header is in seconds
            delayMs = parseInt(retryAfterHeader) * 1000;
          } else {
            // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s
            delayMs = Math.pow(2, attempt + 1) * 1000;
          }

          // Add jitter (±20%) to prevent thundering herd
          const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
          delayMs = Math.floor(delayMs + jitter);

          logger.warn({
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs,
            retryAfter: retryAfterHeader,
          }, 'OAuth token endpoint rate limited (429), retrying after delay');

          if (attempt < maxRetries) {
            await sleep(delayMs);
            continue; // Retry
          } else {
            // Max retries exhausted
            const errorText = await response.text();
            throw new ExternalApiError(
              `OAuth token rate limit exceeded after ${maxRetries + 1} attempts`,
              429,
              'Guesty OAuth',
              { error: errorText, attemptsExhausted: true }
            );
          }
        }

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
          retriedAttempts: attempt,
        }, 'Successfully obtained OAuth access token');

        return this.accessToken;
      } catch (error) {
        lastError = error as Error | ExternalApiError;

        // If it's an ExternalApiError and not a rate limit, throw immediately
        if (error instanceof ExternalApiError && error.statusCode !== 429) {
          throw error;
        }

        // If it's a network error and we have retries left, retry with backoff
        if (!(error instanceof ExternalApiError) && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt + 1) * 1000;
          logger.warn({
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 'OAuth network error, retrying after delay');

          await sleep(delayMs);
          continue; // Retry
        }

        // Network error with no more retries
        if (!(error instanceof ExternalApiError)) {
          throw new ExternalApiError(
            `Failed to obtain OAuth token: ${error instanceof Error ? error.message : 'Unknown error'}`,
            502,
            'Guesty OAuth',
            { originalError: error }
          );
        }
      }
    }

    // Should not reach here, but throw the last error if we do
    throw lastError || new ExternalApiError(
      'OAuth token request failed after all retries',
      500,
      'Guesty OAuth'
    );
  }

  /**
   * Extract and track rate limit information from response headers
   */
  private trackRateLimitHeaders(response: Response): void {
    // Extract rate limit headers (Guesty format: X-ratelimit-limit-<interval>, X-ratelimit-remaining-<interval>)
    const limitSecond = response.headers.get('X-ratelimit-limit-second');
    const remainingSecond = response.headers.get('X-ratelimit-remaining-second');
    const limitMinute = response.headers.get('X-ratelimit-limit-minute');
    const remainingMinute = response.headers.get('X-ratelimit-remaining-minute');
    const limitHour = response.headers.get('X-ratelimit-limit-hour');
    const remainingHour = response.headers.get('X-ratelimit-remaining-hour');

    this.rateLimitInfo = {
      limitPerSecond: limitSecond ? parseInt(limitSecond) : null,
      remainingPerSecond: remainingSecond ? parseInt(remainingSecond) : null,
      limitPerMinute: limitMinute ? parseInt(limitMinute) : null,
      remainingPerMinute: remainingMinute ? parseInt(remainingMinute) : null,
      limitPerHour: limitHour ? parseInt(limitHour) : null,
      remainingPerHour: remainingHour ? parseInt(remainingHour) : null,
    };

    // Warn if approaching rate limits (less than 20% remaining)
    if (this.rateLimitInfo.remainingPerSecond !== null && this.rateLimitInfo.limitPerSecond !== null) {
      const percentRemaining = (this.rateLimitInfo.remainingPerSecond / this.rateLimitInfo.limitPerSecond) * 100;
      if (percentRemaining < 20) {
        logger.warn({
          remaining: this.rateLimitInfo.remainingPerSecond,
          limit: this.rateLimitInfo.limitPerSecond,
          interval: 'second',
        }, 'Approaching rate limit threshold');
      }
    }
  }

  /**
   * Make authenticated request to Guesty API with retry logic and rate limiting
   */
  private async request<T>(endpoint: string, options: RequestInit = {}, maxRetries: number = 3): Promise<T> {
    // Wrap request in rate limiter to respect Guesty API limits
    return this.limiter.schedule(async () => {
      return this.requestWithRetry<T>(endpoint, options, maxRetries);
    });
  }

  /**
   * Internal request method with retry logic (called by rate limiter)
   */
  private async requestWithRetry<T>(endpoint: string, options: RequestInit = {}, maxRetries: number = 3): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError: Error | ExternalApiError | null = null;

    // Get fresh access token (uses cached token if still valid)
    const accessToken = await this.getAccessToken();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();

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

        // Track rate limit headers
        this.trackRateLimitHeaders(response);

        // Handle 429 Rate Limit with retry
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          let delayMs: number;

          if (retryAfterHeader) {
            // Retry-After header is in seconds
            delayMs = parseInt(retryAfterHeader) * 1000;
          } else {
            // Exponential backoff: 1s, 2s, 4s, 8s...
            delayMs = Math.pow(2, attempt) * 1000;
          }

          // Add jitter (±20%) to prevent thundering herd
          const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
          delayMs = Math.floor(delayMs + jitter);

          logger.warn({
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs,
            endpoint,
            retryAfter: retryAfterHeader,
          }, 'Rate limited (429), retrying after delay');

          logApiCall('Guesty', endpoint, 429, duration);

          if (attempt < maxRetries) {
            await sleep(delayMs);
            continue; // Retry
          } else {
            // Max retries exhausted
            throw new ExternalApiError(
              `Rate limit exceeded after ${maxRetries + 1} attempts`,
              429,
              'Guesty',
              { endpoint, rateLimitInfo: this.rateLimitInfo }
            );
          }
        }

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
        lastError = error as Error | ExternalApiError;

        // If it's an ExternalApiError and not a rate limit, throw immediately
        if (error instanceof ExternalApiError && error.statusCode !== 429) {
          throw error;
        }

        // If it's a network error and we have retries left, retry with backoff
        if (!(error instanceof ExternalApiError) && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 'Network error, retrying after delay');

          logApiCall('Guesty', endpoint, 0, duration);
          await sleep(delayMs);
          continue; // Retry
        }

        // Network or parsing error (no more retries)
        if (!(error instanceof ExternalApiError)) {
          logApiCall('Guesty', endpoint, 0, duration);
          throw new ExternalApiError(
            `Failed to communicate with Guesty API: ${error instanceof Error ? error.message : 'Unknown error'}`,
            502,
            'Guesty',
            { originalError: error }
          );
        }
      }
    }

    // Should not reach here, but throw the last error if we do
    throw lastError || new ExternalApiError('Request failed after all retries', 500, 'Guesty');
  }

  /**
   * Get current rate limit information
   */
  getRateLimitInfo(): RateLimitInfo {
    return { ...this.rateLimitInfo };
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
   * Fetch reservations with optional filters
   * Uses Guesty's filter syntax for proper querying
   */
  async getReservations(params?: {
    listingId?: string;
    status?: string[];
    limit?: number;
    skip?: number;
  }): Promise<any[]> {
    logger.debug({ params }, 'Fetching reservations from Guesty API');

    const queryParams = new URLSearchParams();
    const filters: any[] = [];

    // Add listingId filter
    if (params?.listingId) {
      filters.push({
        operator: '$eq',
        field: 'listingId',
        value: params.listingId,
      });
    }

    // Add status filter (use $in for multiple statuses)
    if (params?.status && params.status.length > 0) {
      if (params.status.length === 1) {
        filters.push({
          operator: '$eq',
          field: 'status',
          value: params.status[0],
        });
      } else {
        filters.push({
          operator: '$in',
          field: 'status',
          value: params.status,
        });
      }
    }

    // Add filters to query params (JSON stringified)
    if (filters.length > 0) {
      queryParams.append('filters', JSON.stringify(filters));
    }

    // Specify fields using space-separated format per Guesty API docs
    // Example from docs: fields=_id confirmationCode status checkInDateLocalized...
    const fieldsString = '_id listingId status checkIn checkOut checkInDateLocalized checkOutDateLocalized guest guestsCount source createdAt confirmedAt confirmationCode integration';
    queryParams.append('fields', fieldsString);

    // Set limit
    queryParams.append('limit', (params?.limit || 100).toString());

    if (params?.skip) {
      queryParams.append('skip', params.skip.toString());
    }

    const url = `/reservations?${queryParams.toString()}`;
    const response = await this.request<{ results: any[] }>(url);

    logger.debug(
      { count: response.results?.length || 0 },
      'Reservations fetched successfully'
    );

    return response.results || [];
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