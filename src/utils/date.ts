/**
 * Small pure helpers for YYYY-MM-DD date-string arithmetic (UTC-based, no
 * timezone lookup). Shared by everything that groups/measures booked or
 * blocked day-spans: airbnb-mail iCal reconciliation and Google Calendar
 * block-span building (ticket #365 — was duplicated in both).
 */

/** Add one calendar day to a YYYY-MM-DD date string (UTC, no DST). */
export function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

/** Number of nights between an inclusive start and exclusive end date (both YYYY-MM-DD). */
export function nightsBetween(start: string, endExclusive: string): number {
  return Math.round(
    (Date.parse(`${endExclusive}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  );
}
