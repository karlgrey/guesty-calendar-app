/**
 * Hostex API Client
 *
 * HTTP client for Hostex Open API v3 with Bottleneck rate limiting and
 * exponential-backoff retries. Authenticates via static Hostex-Access-Token
 * header. Unwraps the response envelope so callers see `data` directly.
 *
 * See docs/superpowers/specs/2026-05-13-hostex-integration-design.md
 */

import Bottleneck from 'bottleneck';
import { config } from '../config/index.js';
import { ExternalApiError } from '../utils/errors.js';
import logger, { logApiCall } from '../utils/logger.js';
import type {
  HostexEnvelope,
  HostexProperty,
  HostexPropertiesData,
  HostexReservation,
  HostexReservationsData,
  HostexCalendarResponse,
} from '../types/hostex.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HostexClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly limiter: Bottleneck;

  constructor(
    accessToken: string | undefined = config.hostexAccessToken,
    baseUrl: string = config.hostexApiUrl,
  ) {
    if (!accessToken) {
      throw new Error('HOSTEX_ACCESS_TOKEN is required to construct HostexClient');
    }
    this.accessToken = accessToken;
    this.baseUrl = baseUrl.replace(/\/$/, '');

    // Conservative: 60 requests/min host-wide (1200 cap), 10 concurrent, 1s between.
    this.limiter = new Bottleneck({
      reservoir: 60,
      reservoirRefreshAmount: 60,
      reservoirRefreshInterval: 60_000,
      maxConcurrent: 10,
      minTime: 1000,
    });

    this.limiter.on('depleted', () => {
      logger.debug('Hostex rate limiter reservoir depleted, requests will queue');
    });
  }

  /**
   * Generic call that unwraps the Hostex envelope and applies retries.
   */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        const response = await this.limiter.schedule(() =>
          fetch(url, {
            method,
            headers: {
              'Hostex-Access-Token': this.accessToken,
              'User-Agent': 'guesty-calendar-app',
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          })
        );
        const duration = Date.now() - startTime;
        logApiCall('Hostex', path, response.status, duration);

        // 429 handling: exponential backoff (1s, 2s, 4s, 8s, 16s) — no Retry-After header
        if (response.status === 429) {
          if (attempt >= maxRetries) {
            throw new ExternalApiError(
              `Hostex rate limit exceeded after ${maxRetries + 1} attempts`,
              429,
              'Hostex',
              { path },
            );
          }
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, delayMs, path }, 'Hostex 429, backing off');
          await sleep(delayMs);
          continue;
        }

        // 5xx / network errors: retry with linear backoff (1s, 2s, 4s), max 3 retries
        if (!response.ok && response.status >= 500 && attempt < 3) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, status: response.status, delayMs, path }, 'Hostex 5xx, retrying');
          await sleep(delayMs);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new ExternalApiError(
            `Hostex HTTP ${response.status}: ${text}`,
            response.status,
            'Hostex',
            { path },
          );
        }

        const envelope = (await response.json()) as HostexEnvelope<T>;
        if (envelope.error_code !== 200) {
          throw new ExternalApiError(
            `Hostex ${envelope.error_code}: ${envelope.error_msg} (request_id=${envelope.request_id})`,
            envelope.error_code,
            'Hostex',
            { path, request_id: envelope.request_id },
          );
        }
        return envelope.data;
      } catch (error) {
        lastError = error as Error;
        // Network-level errors: retry with backoff if attempts remain
        if (!(error instanceof ExternalApiError) && attempt < 3) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, delayMs, path, error: lastError.message }, 'Hostex network error, retrying');
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Hostex request failed (unknown reason)');
  }

  /**
   * GET /v3/properties — list all properties
   */
  async getProperties(): Promise<HostexProperty[]> {
    const data = await this.call<HostexPropertiesData>('GET', '/properties?limit=100');
    return data.properties;
  }

  /**
   * GET /v3/reservations — list reservations with pagination
   * Implemented in Task 6.
   */
  async getReservations(opts: {
    propertyId?: string;
    startCheckIn?: string;
    endCheckIn?: string;
  } = {}): Promise<HostexReservation[]> {
    const limit = 100;
    let offset = 0;
    const all: HostexReservation[] = [];
    const safetyMax = 1000; // hard cap to avoid runaway pagination

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (opts.propertyId) params.set('property_id', opts.propertyId);
      if (opts.startCheckIn) params.set('start_check_in_date', opts.startCheckIn);
      if (opts.endCheckIn) params.set('end_check_in_date', opts.endCheckIn);

      const data = await this.call<HostexReservationsData>('GET', `/reservations?${params.toString()}`);
      const batch = data.reservations || [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
      if (all.length >= safetyMax) {
        logger.warn({ all: all.length, safetyMax }, 'Hostex getReservations hit safety cap, stopping pagination');
        break;
      }
    }
    return all;
  }

  /**
   * POST /v3/listings/calendar — calendar for one or more listings
   * Implemented in Task 7.
   */
  async getListingCalendars(_opts: {
    startDate: string;
    endDate: string;
    listings: Array<{ channel_type: string; listing_id: string }>;
  }): Promise<HostexCalendarResponse> {
    throw new Error('Not implemented yet — see Task 7');
  }
}

/**
 * Singleton instance. Throws on construction if HOSTEX_ACCESS_TOKEN is missing,
 * so callers that import this MUST guard with `if (someProperty.provider === 'hostex')`.
 */
let _client: HostexClient | null = null;
export function getHostexClient(): HostexClient {
  if (!_client) _client = new HostexClient();
  return _client;
}
