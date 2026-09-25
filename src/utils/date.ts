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

/** Add N calendar days to a YYYY-MM-DD date string (UTC, no DST). */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Robust UTC parse for DB timestamps (ISO "…Z" or SQLite "YYYY-MM-DD HH:MM:SS", das Format,
 * das `datetime('now')` liefert). Geteilt von `routes/messages.ts` (Alters-Anzeige im
 * Admin-UI) und `services/stale-draft-regen.ts` (#699, Referenzzeit fürs Entwurfs-Alter) —
 * vormals in messages.ts dupliziert.
 */
export function parseUtc(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}
