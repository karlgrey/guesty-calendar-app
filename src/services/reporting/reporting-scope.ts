/**
 * Welche Objekte gehören an einem Tag ins Mail-Reporting? (#1223, Florenz raus)
 *
 * properties.json-Feld `reportingUntil` (YYYY-MM-DD) = letzter Tag im Reporting.
 * Maßgeblich ist der Kalendertag des Versands in Europe/Berlin: Weekly Summary vom
 * Mo 23.11. geht bei reportingUntil "2026-11-23" noch raus, der vom Mo 30.11. nicht mehr.
 */
import { toZonedTime } from 'date-fns-tz';
import type { PropertyConfig } from '../../config/properties.js';

export const REPORTING_TIMEZONE = 'Europe/Berlin';

/** Kalendertag (YYYY-MM-DD) von `now` in der Zeitzone. */
export function dayInTimezone(now: Date, timezone: string = REPORTING_TIMEZONE): string {
  const zoned = toZonedTime(now, timezone);
  const yyyy = zoned.getFullYear();
  const mm = String(zoned.getMonth() + 1).padStart(2, '0');
  const dd = String(zoned.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** true, solange das Objekt am Versandtag (Berlin) noch im Reporting ist. */
export function isPropertyInReporting(property: Pick<PropertyConfig, 'reportingUntil'>, now: Date): boolean {
  if (!property.reportingUntil) return true;
  return dayInTimezone(now) <= property.reportingUntil;
}

/** Filtert die Objekte, die am Versandtag ins Reporting gehören. */
export function filterPropertiesInReporting<T extends Pick<PropertyConfig, 'reportingUntil'>>(properties: T[], now: Date): T[] {
  return properties.filter((p) => isPropertyInReporting(p, now));
}
