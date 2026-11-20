/**
 * Kalender-Report "Nächste Gäste" je Objekt (report-type calendar-weekly, #1223/#1284).
 *
 * Eine Mail PRO Objekt an dessen Abonnenten: die nächsten 5 kommenden Buchungen (wie im
 * Weekly Summary), ohne Preise und Kontaktdaten. `weeklyReport.enabled` spielt hier keine Rolle.
 */
import { getISOWeek } from 'date-fns';
import { getAllProperties, getListingId, type PropertyConfig } from '../config/properties.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import { getActiveRecipientEmails } from '../repositories/report-recipient-repository.js';
import { sendEmail } from '../services/email-service.js';
import {
  calendarEmailSubject,
  channelLabel,
  firstNameOf,
  generateCalendarEmail,
  type CalendarReportModel,
} from '../services/calendar-email-templates.js';
import { dayInTimezone, isPropertyInReporting } from '../services/reporting/reporting-scope.js';
import logger from '../utils/logger.js';

/** Anzahl Buchungen in der Tabelle (wie "Next 5 Upcoming Bookings" im Weekly Summary). */
export const CALENDAR_BOOKINGS_LIMIT = 5;

export interface CalendarSendResult {
  success: boolean;
  sent: boolean;
  propertySlug: string;
  recipientCount?: number;
  error?: string;
}

/** Baut das Modell eines Objekts. DB-I/O über das Reservation-Repo. */
export function buildCalendarReportModel(property: PropertyConfig, now: Date): CalendarReportModel {
  const upcoming = getReservationsByPeriod(getListingId(property), 365, 'future').slice(0, CALENDAR_BOOKINGS_LIMIT);
  return {
    propertySlug: property.slug,
    propertyName: property.name,
    weekNumber: getISOWeek(new Date(`${dayInTimezone(now)}T00:00:00`)),
    bookings: upcoming.map((r) => ({
      firstName: firstNameOf(r.guest_name),
      channel: channelLabel(r.source, r.platform),
      checkIn: r.check_in,
      checkOut: r.check_out,
      nights: r.nights_count ?? 0,
      guests: r.guests_count ?? 0,
      status: r.status,
    })),
  };
}

/** Versendet den Kalender-Report eines Objekts an dessen DB-Empfänger (calendar-weekly). */
export async function sendCalendarWeeklyEmailForProperty(
  property: PropertyConfig,
  now: Date = new Date()
): Promise<CalendarSendResult> {
  const propertySlug = property.slug;

  if (!isPropertyInReporting(property, now)) {
    logger.info(
      { propertySlug, reportingUntil: property.reportingUntil },
      `Kalender-Report: ${property.name} aus dem Reporting genommen (reportingUntil ${property.reportingUntil})`
    );
    return { success: true, sent: false, propertySlug, error: 'Not in reporting' };
  }

  try {
    // Empfänger bei jedem Versand frisch aus der DB
    const recipients = getActiveRecipientEmails('calendar-weekly', propertySlug);
    if (!recipients.length) {
      logger.info({ propertySlug }, `Kalender-Report: kein aktiver Empfänger für ${property.name}, keine Mail`);
      return { success: true, sent: false, propertySlug, error: 'No recipients' };
    }

    const model = buildCalendarReportModel(property, now);
    const { html, text } = generateCalendarEmail(model);
    const sent = await sendEmail({ to: recipients, subject: calendarEmailSubject(model), html, text });
    if (sent) {
      logger.info(
        { propertySlug, recipientCount: recipients.length, recipients, bookings: model.bookings.length },
        `✅ Kalender-Report gesendet für ${property.name}`
      );
      return { success: true, sent: true, propertySlug, recipientCount: recipients.length };
    }
    logger.error({ propertySlug, recipientCount: recipients.length }, `❌ Kalender-Report: Versand fehlgeschlagen für ${property.name}`);
    return { success: false, sent: false, propertySlug, recipientCount: recipients.length, error: 'Email sending failed' };
  } catch (error) {
    logger.error({ error, propertySlug }, `❌ Kalender-Report fehlgeschlagen für ${property.name}`);
    return { success: false, sent: false, propertySlug, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/** Alle Objekte nacheinander (Testskript); liefert die Ergebnisse je Objekt. */
export async function sendCalendarWeeklyEmails(now: Date = new Date()): Promise<CalendarSendResult[]> {
  const results: CalendarSendResult[] = [];
  for (const property of getAllProperties()) {
    results.push(await sendCalendarWeeklyEmailForProperty(property, now));
  }
  return results;
}
