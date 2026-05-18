/**
 * Airbnb iCal Parser
 *
 * Wraps node-ical to normalise events for downstream availability mapping.
 */

import * as ical from 'node-ical';
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

export function parseAirbnbIcal(icsBody: string): AirbnbIcalEvent[] {
  const parsed = ical.sync.parseICS(icsBody);
  const out: AirbnbIcalEvent[] = [];
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key];
    if (entry.type !== 'VEVENT') continue;
    const uid = (entry.uid ?? key) as string;
    const reservationCode = uid.split('@')[0];
    out.push({
      uid,
      reservationCode,
      startDate: formatDate(entry.start as Date),
      endDate: formatDate(entry.end as Date),
      summary: (entry.summary ?? '') as string,
    });
  }
  return out;
}
