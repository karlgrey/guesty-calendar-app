/**
 * Google Calendar Client
 *
 * Writes booking events to shared Google Calendars using the Calendar API.
 * Uses the same service account as GA4 (data/ga4-service-account.json).
 */

import { google, calendar_v3 } from 'googleapis';
import { GoogleAuth } from 'googleapis-common';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_KEY_FILE = path.resolve(__dirname, '../../data/ga4-service-account.json');

/**
 * Convert a Guesty reservation_id to a valid Google Calendar event ID.
 * Google requires: lowercase alphanumeric, 5-1024 chars.
 */
export function toGoogleEventId(reservationId: string): string {
  return reservationId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Google Calendar Client - Singleton
 */
class GoogleCalendarClient {
  private calendar: calendar_v3.Calendar | null = null;

  /**
   * Get or initialize the Calendar API client
   */
  private getCalendar(): calendar_v3.Calendar {
    if (this.calendar) {
      return this.calendar;
    }

    const keyFile = DEFAULT_KEY_FILE;

    logger.debug({ keyFile }, 'Initializing Google Calendar client');

    const auth = new GoogleAuth({
      keyFile,
      scopes: SCOPES,
    });

    this.calendar = google.calendar({ version: 'v3', auth });
    return this.calendar;
  }

  /**
   * Insert or update a calendar event.
   * Tries update first; falls back to insert if event doesn't exist.
   */
  async upsertEvent(
    calendarId: string,
    eventId: string,
    event: calendar_v3.Schema$Event
  ): Promise<'created' | 'updated'> {
    const cal = this.getCalendar();

    try {
      // Try update first
      await cal.events.update({
        calendarId,
        eventId,
        requestBody: event,
      });
      return 'updated';
    } catch (error: any) {
      if (error?.code === 404 || error?.status === 404) {
        // Event doesn't exist yet, insert it
        await cal.events.insert({
          calendarId,
          requestBody: { ...event, id: eventId },
        });
        return 'created';
      }
      throw error;
    }
  }

  /**
   * Delete a calendar event. Silently ignores if event doesn't exist.
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<boolean> {
    const cal = this.getCalendar();

    try {
      await cal.events.delete({ calendarId, eventId });
      return true;
    } catch (error: any) {
      if (error?.code === 404 || error?.status === 404) {
        return false; // Already gone
      }
      if (error?.code === 410 || error?.status === 410) {
        return false; // Already deleted (Gone)
      }
      throw error;
    }
  }

  /**
   * List existing events in a calendar (for sync comparison).
   */
  async listEvents(
    calendarId: string,
    timeMin?: string,
    timeMax?: string
  ): Promise<calendar_v3.Schema$Event[]> {
    const cal = this.getCalendar();
    const events: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;

    do {
      const res = await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults: 2500,
        singleEvents: true,
        pageToken,
      });

      if (res.data.items) {
        events.push(...res.data.items);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return events;
  }

  /**
   * Test connection by listing a single event.
   */
  async testConnection(calendarId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const cal = this.getCalendar();
      await cal.events.list({
        calendarId,
        maxResults: 1,
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, calendarId }, 'Google Calendar connection test failed');
      return { success: false, error: message };
    }
  }
}

// Export singleton instance
export const googleCalendarClient = new GoogleCalendarClient();
