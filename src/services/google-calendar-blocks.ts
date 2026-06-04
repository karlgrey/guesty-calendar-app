/**
 * Pure builders for syncing blocked (non-rentable) availability spans to a
 * shared Google Calendar. No I/O — the sync job does the API calls.
 */
import type { calendar_v3 } from 'googleapis';
import { toGoogleEventId } from './google-event-id.js';

export interface BlockSpan {
  startDate: string;     // YYYY-MM-DD, inclusive
  endExclusive: string;  // YYYY-MM-DD, exclusive (Google all-day end)
  blockType: string | null;
}

function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().split('T')[0];
}

/** Group consecutive `status==='blocked'` days into spans (end exclusive). */
export function buildBlockSpans(
  days: Array<{ date: string; status: string; block_type: string | null }>
): BlockSpan[] {
  const blocked = days
    .filter((d) => d.status === 'blocked')
    .sort((a, b) => a.date.localeCompare(b.date));
  const spans: BlockSpan[] = [];
  for (const day of blocked) {
    const last = spans[spans.length - 1];
    if (last && last.endExclusive === day.date) {
      last.endExclusive = addOneDay(day.date); // extend contiguous span
    } else {
      spans.push({ startDate: day.date, endExclusive: addOneDay(day.date), blockType: day.block_type });
    }
  }
  return spans;
}

const BLOCK_TITLES: Record<string, string> = {
  owner: '🔒 Owner-Block',
  maintenance: '🔒 Blockiert (Wartung)',
  manual: '🔒 Blockiert (manuell)',
};

/** Stable, base32hex-safe event id, namespaced to avoid reservation-id collisions. */
export function blockEventId(listingId: string, startDate: string): string {
  return toGoogleEventId(`blk-${listingId}-${startDate}`);
}

/** Build an all-day Google Calendar event for a blocked span. */
export function buildBlockEvent(span: BlockSpan, propertyName: string): calendar_v3.Schema$Event {
  return {
    summary: (span.blockType && BLOCK_TITLES[span.blockType]) || '🔒 Blockiert',
    location: propertyName,
    start: { date: span.startDate },
    end: { date: span.endExclusive },
    transparency: 'opaque',
    extendedProperties: { private: { kind: 'owner-block' } },
  };
}
