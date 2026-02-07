/**
 * Google Calendar Sync Job
 *
 * Syncs reservation data to shared Google Calendars.
 * Runs after each ETL cycle (every 30 min) for properties with googleCalendar enabled.
 */

import { googleCalendarClient, toGoogleEventId } from '../services/google-calendar-client.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import type { PropertyConfig } from '../config/properties.js';
import type { Reservation } from '../types/models.js';
import logger from '../utils/logger.js';

export interface GoogleCalendarSyncResult {
  success: boolean;
  eventsUpserted: number;
  eventsDeleted: number;
  error?: string;
  durationMs?: number;
}

/**
 * Build a Google Calendar event from a reservation
 */
function buildCalendarEvent(reservation: Reservation, propertyName: string) {
  const guestName = reservation.guest_name || 'Unknown Guest';
  const nights = reservation.nights_count || 0;
  const guests = reservation.guests_count || 0;
  const status = reservation.status.charAt(0).toUpperCase() + reservation.status.slice(1);
  const source = reservation.source || reservation.platform || 'Direct';

  // Use localized dates for all-day events (DATE format, no time)
  const checkIn = (reservation.check_in_localized || reservation.check_in).split('T')[0];
  const checkOut = (reservation.check_out_localized || reservation.check_out).split('T')[0];

  return {
    summary: `${guestName} (${nights}N, ${guests} guests)`,
    description: [
      `Status: ${status}`,
      `Nights: ${nights}`,
      `Guests: ${guests}`,
      `Source: ${source}`,
    ].join('\n'),
    location: propertyName,
    start: { date: checkIn },
    end: { date: checkOut },
    transparency: 'opaque' as const,
  };
}

/**
 * Sync Google Calendar for a single property
 */
export async function syncGoogleCalendarForProperty(
  property: PropertyConfig
): Promise<GoogleCalendarSyncResult> {
  const startTime = Date.now();
  const { slug, name, guestyPropertyId, googleCalendar } = property;

  if (!googleCalendar?.enabled || !googleCalendar.calendarId) {
    return { success: true, eventsUpserted: 0, eventsDeleted: 0 };
  }

  const calendarId = googleCalendar.calendarId;

  logger.info({ propertySlug: slug, calendarId }, 'Starting Google Calendar sync');

  try {
    // Get past 6 months + future 12 months of reservations (same range as iCal)
    const pastReservations = getReservationsByPeriod(guestyPropertyId, 180, 'past');
    const futureReservations = getReservationsByPeriod(guestyPropertyId, 365, 'future');

    // Deduplicate by reservation_id
    const seen = new Set<string>();
    const activeReservations: Reservation[] = [];
    const cancelledReservations: Reservation[] = [];

    for (const r of [...futureReservations, ...pastReservations]) {
      if (seen.has(r.reservation_id)) continue;
      seen.add(r.reservation_id);

      if (r.status === 'canceled' || r.status === 'cancelled' || r.status === 'declined') {
        cancelledReservations.push(r);
      } else {
        activeReservations.push(r);
      }
    }

    let eventsUpserted = 0;
    let eventsDeleted = 0;

    // Upsert active reservations
    for (const reservation of activeReservations) {
      try {
        const eventId = toGoogleEventId(reservation.reservation_id);
        const event = buildCalendarEvent(reservation, name);
        await googleCalendarClient.upsertEvent(calendarId, eventId, event);
        eventsUpserted++;
      } catch (error) {
        logger.warn(
          { error, reservationId: reservation.reservation_id, propertySlug: slug },
          'Failed to upsert calendar event'
        );
      }
    }

    // Delete cancelled reservations
    for (const reservation of cancelledReservations) {
      try {
        const eventId = toGoogleEventId(reservation.reservation_id);
        const deleted = await googleCalendarClient.deleteEvent(calendarId, eventId);
        if (deleted) eventsDeleted++;
      } catch (error) {
        logger.warn(
          { error, reservationId: reservation.reservation_id, propertySlug: slug },
          'Failed to delete calendar event'
        );
      }
    }

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        propertySlug: slug,
        eventsUpserted,
        eventsDeleted,
        totalReservations: activeReservations.length,
        cancelledReservations: cancelledReservations.length,
        durationMs,
      },
      'Google Calendar sync completed'
    );

    return { success: true, eventsUpserted, eventsDeleted, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error(
      { error, propertySlug: slug, calendarId, durationMs },
      'Google Calendar sync failed'
    );

    return { success: false, eventsUpserted: 0, eventsDeleted: 0, error: errorMessage, durationMs };
  }
}
