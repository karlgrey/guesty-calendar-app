/**
 * Google Calendar Sync Job
 *
 * Syncs reservation data to shared Google Calendars.
 * Runs after each ETL cycle (every 30 min) for properties with googleCalendar enabled.
 */

import { googleCalendarClient, toGoogleEventId } from '../services/google-calendar-client.js';
import { getReservationsByPeriod, getCancelledReservationIds } from '../repositories/reservation-repository.js';
import { getListingById } from '../repositories/listings-repository.js';
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
 * Add one day to a YYYY-MM-DD date string
 */
function addOneDay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Format a YYYY-MM-DD date string in German: "Do, 15. Aug 2025"
 */
function formatDateDE(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  return `${days[d.getDay()]}, ${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Build a Google Calendar event from a reservation
 */
function buildCalendarEvent(
  reservation: Reservation,
  propertyName: string,
  checkInTime: string | undefined,
  checkOutTime: string | undefined
) {
  const guestName = reservation.guest_name || 'Unknown Guest';
  const nights = reservation.nights_count || 0;
  const guests = reservation.guests_count || 0;
  const status = reservation.status.charAt(0).toUpperCase() + reservation.status.slice(1);
  const source = reservation.source || reservation.platform || 'Direct';

  const checkIn = (reservation.check_in_localized || reservation.check_in).split('T')[0];
  const checkOut = (reservation.check_out_localized || reservation.check_out).split('T')[0];

  // End date +1 day: Google all-day events use exclusive end date,
  // but guests are still present on checkout day until checkout time.
  const endDate = addOneDay(checkOut);

  const descLines = [
    `Status: ${status}`,
    `Check-in: ${formatDateDE(checkIn)}${checkInTime ? ' ab ' + checkInTime + ' Uhr' : ''}`,
    `Check-out: ${formatDateDE(checkOut)}${checkOutTime ? ' bis ' + checkOutTime + ' Uhr' : ''}`,
    `Nächte: ${nights}`,
    `Gäste: ${guests}`,
    `Quelle: ${source}`,
  ];

  return {
    summary: `${guestName} (${nights}N, ${guests} Gäste)`,
    description: descLines.join('\n'),
    location: propertyName,
    start: { date: checkIn },
    end: { date: endDate },
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
    // Check-in/out times: listing (from Guesty) takes priority, config as fallback
    const listing = getListingById(guestyPropertyId);
    const checkInTime = listing?.check_in_time || googleCalendar.checkInTime;
    const checkOutTime = listing?.check_out_time || googleCalendar.checkOutTime;

    // Get past 6 months + future 12 months of active reservations
    const pastReservations = getReservationsByPeriod(guestyPropertyId, 180, 'past');
    const futureReservations = getReservationsByPeriod(guestyPropertyId, 365, 'future');

    // Get cancelled/declined reservation IDs from inquiries table (for cleanup)
    const cancelledReservationIds = getCancelledReservationIds(guestyPropertyId, 180, 365);

    // Deduplicate active reservations by reservation_id
    const seen = new Set<string>();
    const activeReservations: Reservation[] = [];

    for (const r of [...futureReservations, ...pastReservations]) {
      if (seen.has(r.reservation_id)) continue;
      seen.add(r.reservation_id);
      activeReservations.push(r);
    }

    let eventsUpserted = 0;
    let eventsDeleted = 0;

    // Upsert active reservations
    for (const reservation of activeReservations) {
      try {
        const eventId = toGoogleEventId(reservation.reservation_id);
        const event = buildCalendarEvent(reservation, name, checkInTime, checkOutTime);
        await googleCalendarClient.upsertEvent(calendarId, eventId, event);
        eventsUpserted++;
        // Small delay to avoid Google Calendar API rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : error, reservationId: reservation.reservation_id, propertySlug: slug },
          'Failed to upsert calendar event'
        );
      }
    }

    // Delete cancelled/expired/closed reservations from calendar
    for (const reservationId of cancelledReservationIds) {
      try {
        const eventId = toGoogleEventId(reservationId);
        const deleted = await googleCalendarClient.deleteEvent(calendarId, eventId);
        if (deleted) eventsDeleted++;
        // Small delay to avoid Google Calendar API rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : error, reservationId, propertySlug: slug },
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
        cancelledReservations: cancelledReservationIds.length,
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
