/**
 * Kalender-Report "Nächste Gäste" (report-type calendar-weekly, #1223).
 *
 * Eine Mail für alle Objekte im Reporting: Fenster heute (Berlin) bis heute+14 Tage inklusive,
 * je Objekt chronologisch Aufenthalte (aktive Status) und geblockte Zeiträume.
 * Keine Preise, Kennzahlen oder Kontaktdaten.
 */
import { addDays, format, getISOWeek } from 'date-fns';
import { getAllProperties, getListingId, type PropertyConfig } from '../config/properties.js';
import { getAvailability } from '../repositories/availability-repository.js';
import { ACTIVE_RESERVATION_STATUSES, getReservationsInRange } from '../repositories/reservation-repository.js';
import { getActiveRecipientEmails } from '../repositories/report-recipient-repository.js';
import { buildBlockSpans } from '../services/google-calendar-blocks.js';
import { sendEmail } from '../services/email-service.js';
import {
  calendarEmailSubject,
  channelLabel,
  firstNameOf,
  generateCalendarEmail,
  type CalendarEntry,
  type CalendarReportModel,
} from '../services/calendar-email-templates.js';
import { dayInTimezone, filterPropertiesInReporting } from '../services/reporting/reporting-scope.js';
import logger from '../utils/logger.js';

/** Vorschau-Fenster: heute + 14 Tage (inklusive). */
export const CALENDAR_WINDOW_DAYS = 14;

const day = (iso: string) => iso.slice(0, 10);

/** Baut das Modell. Gesamte DB-I/O über die importierten Repos. */
export function buildCalendarReportModel(properties: PropertyConfig[], now: Date): CalendarReportModel {
  const windowStart = dayInTimezone(now);
  const startDate = new Date(`${windowStart}T00:00:00`);
  const windowEnd = format(addDays(startDate, CALENDAR_WINDOW_DAYS), 'yyyy-MM-dd');
  const endExclusive = format(addDays(startDate, CALENDAR_WINDOW_DAYS + 1), 'yyyy-MM-dd');
  const active = ACTIVE_RESERVATION_STATUSES as readonly string[];

  const result: CalendarReportModel['properties'] = [];
  for (const property of properties) {
    try {
      const listingId = getListingId(property);

      // getReservationsInRange liefert Überlappungen inkl. aller Status -> aktive filtern
      const stays = getReservationsInRange(listingId, windowStart, windowEnd)
        .filter((r) => active.includes(r.status) && day(r.check_in) <= windowEnd && day(r.check_out) >= windowStart);

      const entries: Array<CalendarEntry & { sortKey: string; order: number }> = stays.map((r) => ({
        kind: 'stay' as const,
        checkIn: day(r.check_in),
        checkOut: day(r.check_out),
        firstName: firstNameOf(r.guest_name),
        guests: r.guests_count ?? null,
        channel: channelLabel(r.source, r.platform),
        sortKey: day(r.check_in),
        order: 0,
      }));

      // Nächte eines gelisteten Aufenthalts zählen nie als "geblockt": Guesty-Holds (Status
      // reserved) kommen lokal als status='blocked' an und stünden sonst doppelt im Report.
      const isStayNight = (d: string) => stays.some((r) => day(r.check_in) <= d && d < day(r.check_out));
      const blocked = getAvailability(listingId, windowStart, windowEnd)
        .map((a) => ({
          date: day(a.date),
          status: a.status as string,
          block_type: (a.block_type ?? null) as string | null,
        }))
        .filter((a) => !isStayNight(a.date));
      // Spans nach block_type getrennt -> für den Report zusammenhängende Zeiträume wieder verschmelzen
      const merged: Array<{ from: string; to: string }> = [];
      for (const span of buildBlockSpans(blocked).sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        const from = span.startDate < windowStart ? windowStart : span.startDate;
        const exclusive = span.endExclusive > endExclusive ? endExclusive : span.endExclusive;
        if (exclusive <= from) continue;
        const to = format(addDays(new Date(`${exclusive}T00:00:00`), -1), 'yyyy-MM-dd');
        const last = merged[merged.length - 1];
        if (last && format(addDays(new Date(`${last.to}T00:00:00`), 1), 'yyyy-MM-dd') === from) last.to = to;
        else merged.push({ from, to });
      }
      for (const b of merged) entries.push({ kind: 'block', from: b.from, to: b.to, sortKey: b.from, order: 1 });

      entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.order - b.order);
      result.push({
        slug: property.slug,
        name: property.name,
        entries: entries.map(({ sortKey: _s, order: _o, ...e }) => e as CalendarEntry),
      });
    } catch (error) {
      logger.error({ error, propertySlug: property.slug }, 'Calendar report: failed to gather property data, skipping');
    }
  }

  return {
    generatedAt: now.toISOString(),
    windowStart,
    windowEnd,
    weekNumber: getISOWeek(startDate),
    properties: result,
  };
}

/** Versendet den Kalender-Report an die DB-Empfänger (calendar-weekly). */
export async function sendCalendarWeeklyEmail(
  now: Date = new Date()
): Promise<{ success: boolean; sent: boolean; error?: string }> {
  // Empfänger bei jedem Versand frisch aus der DB
  const recipients = getActiveRecipientEmails('calendar-weekly');
  if (!recipients.length) {
    logger.warn('Calendar weekly report: no recipients configured');
    return { success: true, sent: false, error: 'No recipients' };
  }

  try {
    const properties = filterPropertiesInReporting(getAllProperties(), now);
    const model = buildCalendarReportModel(properties, now);
    const { html, text } = generateCalendarEmail(model);
    const sent = await sendEmail({ to: recipients, subject: calendarEmailSubject(model), html, text });
    if (sent) {
      logger.info({ recipients: recipients.length, properties: model.properties.length }, '✅ Calendar weekly report email sent');
      return { success: true, sent: true };
    }
    return { success: false, sent: false, error: 'Email sending failed' };
  } catch (error) {
    logger.error({ error }, '❌ Calendar weekly report email job failed');
    return { success: false, sent: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
