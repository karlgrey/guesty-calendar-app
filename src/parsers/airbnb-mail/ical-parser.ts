/**
 * Airbnb iCal Parser
 *
 * Wraps node-ical to normalise events for downstream availability mapping.
 */

import ical from 'node-ical';
import type { VEvent } from 'node-ical';
import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';

function formatDate(d: Date): string {
  // node-ical parses VALUE=DATE entries as local-time midnight (dateOnly: true).
  // Using local-time getters avoids off-by-one errors from UTC conversion in
  // timezones east of UTC (e.g. Europe/Berlin, where midnight = 22:00 UTC prev day).
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Real Airbnb private-iCal feeds use an OPAQUE UID (e.g.
// "1418fb94e984-b0b674ed8d98a9a821c0af037a6b643e@airbnb.com") that does NOT
// contain the HM reservation code — the code only appears inside DESCRIPTION's
// "Reservation URL: https://www.airbnb.com/…/reservations/details/HMxxxxx"
// line. Calibrated against a live export (Firenze, Aug 2026).
const DESCRIPTION_CODE_RE = /reservations\/details\/(HM[A-Za-z0-9]+)/;

function extractReservationCode(uid: string, description: string | undefined): string {
  const match = description?.match(DESCRIPTION_CODE_RE);
  if (match) return match[1];
  // Owner/block events (and any malformed/old-format entry) have no
  // Reservation URL — fall back to the UID prefix as before.
  return uid.split('@')[0];
}

export function parseAirbnbIcal(icsBody: string): AirbnbIcalEvent[] {
  const parsed = ical.sync.parseICS(icsBody);
  const out: AirbnbIcalEvent[] = [];
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key];
    if (!entry || entry.type !== 'VEVENT') continue;
    const vevent = entry as VEvent;
    const uid = (vevent.uid ?? key) as string;
    const reservationCode = extractReservationCode(uid, vevent.description as string | undefined);
    out.push({
      uid,
      reservationCode,
      startDate: formatDate(vevent.start as Date),
      endDate: formatDate(vevent.end as Date),
      summary: (vevent.summary ?? '') as string,
    });
  }
  return out;
}
