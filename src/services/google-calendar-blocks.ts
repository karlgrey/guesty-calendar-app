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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function nightsBetween(startDate: string, endExclusive: string): number {
  return Math.round((new Date(`${endExclusive}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / MS_PER_DAY);
}

/** German DD.MM. for a YYYY-MM-DD date. */
function ddmm(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}.`;
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
    if (last && last.endExclusive === day.date && last.blockType === day.block_type) {
      last.endExclusive = addOneDay(day.date); // extend contiguous same-reason span
    } else {
      spans.push({ startDate: day.date, endExclusive: addOneDay(day.date), blockType: day.block_type });
    }
  }
  return spans;
}

const PROVIDER_LABELS: Record<string, string> = {
  guesty: 'Guesty',
  hostex: 'Hostex',
  'airbnb-mail': 'Airbnb',
};

/** Best available block reason/source label (no emoji). */
export function blockLabel(blockType: string | null, provider: string): string {
  if (blockType === 'owner') return 'Owner-Block';
  if (blockType === 'maintenance') return 'Wartung';
  if (blockType === 'manual') return 'Manuell blockiert';
  if (provider === 'hostex') return 'Blockiert (Hostex)';
  if (provider === 'airbnb-mail') return 'Blockiert (Airbnb)';
  return 'Blockiert';
}

/** Stable, base32hex-safe event id, namespaced to avoid reservation-id collisions. */
export function blockEventId(listingId: string, startDate: string): string {
  return toGoogleEventId(`blk-${listingId}-${startDate}`);
}

/** Build an all-day Google Calendar event for a blocked span. */
export function buildBlockEvent(span: BlockSpan, propertyName: string, provider: string): calendar_v3.Schema$Event {
  const nights = nightsBetween(span.startDate, span.endExclusive);
  const source = PROVIDER_LABELS[provider] ?? provider;
  return {
    summary: blockLabel(span.blockType, provider),
    description: `Quelle: ${source} · ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} · ${ddmm(span.startDate)}–${ddmm(span.endExclusive)}`,
    location: propertyName,
    start: { date: span.startDate },
    end: { date: span.endExclusive },
    transparency: 'opaque',
    extendedProperties: { private: { kind: 'owner-block' } },
  };
}
