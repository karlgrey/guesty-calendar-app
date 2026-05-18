/**
 * Airbnb iCal Fetcher
 *
 * Downloads the raw .ics body from a private Airbnb calendar URL.
 * Used by sync-ical.ts.
 */

import { ExternalApiError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAirbnbIcal(url: string): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'guesty-calendar-app' },
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ status: res.status, attempt, delayMs }, 'iCal fetch 5xx, retrying');
          await sleep(delayMs);
          continue;
        }
        throw new ExternalApiError(
          `Airbnb iCal HTTP ${res.status}`,
          res.status,
          'Airbnb-iCal',
          { url: url.replace(/[?].*$/, '?…') }
        );
      }
      return await res.text();
    } catch (error) {
      lastError = error as Error;
      if (!(error instanceof ExternalApiError) && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000;
        logger.warn({ error, attempt, delayMs }, 'iCal network error, retrying');
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('iCal fetch failed (unknown reason)');
}
