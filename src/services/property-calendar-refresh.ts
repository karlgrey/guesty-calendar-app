/**
 * Nach einer Kalender-Mutation über die Agent-API (#1167, Guesty-Blocker): lokale Availability
 * frisch von Guesty ziehen (Website) und danach den Google-Kalender des Objekts nachziehen.
 * Fire-and-forget per setImmediate NACH dem Senden der Antwort (ein Objekt-Sync dauert Minuten).
 * In-Memory-Guard je Slug: läuft schon ein Refresh, wird genau ein Nachlauf vermerkt.
 */

import type { PropertyConfig } from '../config/properties.js';
import { syncAvailability } from '../jobs/sync-availability.js';
import { syncGoogleCalendarForProperty } from '../jobs/sync-google-calendar.js';
import logger from '../utils/logger.js';

const running = new Map<string, { again: boolean }>();

/** nur für Tests */
export function resetPropertyCalendarRefreshGuard(): void { running.clear(); }

export async function runPropertyCalendarRefresh(property: PropertyConfig, listingId: string): Promise<void> {
  const state = running.get(property.slug);
  if (state) { state.again = true; return; }
  const cur = { again: false };
  running.set(property.slug, cur);
  try {
    do {
      cur.again = false;
      try {
        const r = await syncAvailability(listingId, true);
        if (!r.success) logger.warn({ slug: property.slug, error: r.error }, 'Availability-Sync nach Kalender-Mutation fehlgeschlagen (non-fatal)');
      } catch (error) {
        logger.warn({ slug: property.slug, error }, 'Availability-Sync nach Kalender-Mutation geworfen (non-fatal)');
      }
      if (property.googleCalendar?.enabled) {
        try {
          const g = await syncGoogleCalendarForProperty(property);
          if (!g.success) logger.warn({ slug: property.slug, error: g.error }, 'Google-Kalender-Sync nach Kalender-Mutation fehlgeschlagen (non-fatal)');
        } catch (error) {
          logger.warn({ slug: property.slug, error }, 'Google-Kalender-Sync nach Kalender-Mutation geworfen (non-fatal)');
        }
      }
    } while (cur.again);
  } finally {
    running.delete(property.slug);
  }
}

/** Startet den Refresh nach dem aktuellen Tick; Rückgabe = Antwortfeld `calendarSync`. */
export function triggerPropertyCalendarRefresh(property: PropertyConfig, listingId: string): string {
  setImmediate(() => { void runPropertyCalendarRefresh(property, listingId); });
  return property.googleCalendar?.enabled ? 'angestoßen' : 'angestoßen (ohne Google-Kalender)';
}
