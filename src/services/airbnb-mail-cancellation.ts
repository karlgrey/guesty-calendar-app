/**
 * #1143: Storno einer airbnb-mail/airbnb-ical-Reservierung per Agent-API.
 * Die Mail-Pipeline erkennt Stornos nicht zuverlässig — hier setzt der Agent
 * den Status manuell. Zeile bleibt (Payout unverändert), Google-Event wird gelöscht.
 */
import { getReservationById, markReservationCanceled } from '../repositories/reservation-repository.js';
import { findPropertyByListingId } from '../config/properties.js';
import { googleCalendarClient } from './google-calendar-client.js';
import { toGoogleEventId } from './google-event-id.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export const AIRBNB_MAIL_PLATFORMS = ['airbnb-mail', 'airbnb-ical'] as const;

export interface AirbnbMailCancelResult {
  code: string;
  property: string | null;
  previousStatus: string;
  status: 'canceled';
  calendarEventDeleted: boolean;
  alreadyCanceled: boolean;
}

export async function cancelAirbnbMailReservation(code: string, reason?: string): Promise<AirbnbMailCancelResult> {
  const trimmed = code.trim();
  let row = getReservationById(trimmed);
  if (!row && trimmed.toUpperCase() !== trimmed) row = getReservationById(trimmed.toUpperCase());
  if (!row) throw new NotFoundError(`Reservation ${trimmed} not found`);

  if (!(AIRBNB_MAIL_PLATFORMS as readonly (string | null)[]).includes(row.platform)) {
    throw new ConflictError(
      `Reservation ${row.reservation_id} has platform '${row.platform ?? 'unknown'}' — only airbnb-mail/airbnb-ical reservations can be canceled here (Guesty: POST /reservations/:id/cancel)`
    );
  }

  const previousStatus = row.status;
  const alreadyCanceled = previousStatus === 'canceled' || previousStatus === 'cancelled';
  if (!alreadyCanceled) markReservationCanceled(row.reservation_id);

  const property = findPropertyByListingId(row.listing_id);
  let calendarEventDeleted = false;
  const calendarId = property?.googleCalendar?.enabled ? property.googleCalendar.calendarId : undefined;
  if (calendarId) {
    try {
      // false = Event existiert nicht (mehr) (404/410) — ebenfalls Erfolg
      await googleCalendarClient.deleteEvent(calendarId, toGoogleEventId(row.reservation_id));
      calendarEventDeleted = true;
    } catch (error) {
      logger.warn({ error, code: row.reservation_id }, 'Airbnb-mail cancel: Google event delete failed (retry by calling again)');
    }
  }

  const slug = property?.slug ?? null;
  logger.info(
    { code: row.reservation_id, property: slug, previousStatus, alreadyCanceled, reason, calendarEventDeleted },
    'Airbnb-mail reservation canceled'
  );
  return { code: row.reservation_id, property: slug, previousStatus, status: 'canceled', calendarEventDeleted, alreadyCanceled };
}
