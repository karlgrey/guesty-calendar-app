/**
 * Pure builders for syncing blocked (non-rentable) availability spans to a
 * shared Google Calendar. No I/O — the sync job does the API calls.
 */
import type { calendar_v3 } from 'googleapis';
import { toGoogleEventId } from './google-event-id.js';
import { addOneDay, nightsBetween } from '../utils/date.js';

export interface BlockSpan {
  startDate: string;     // YYYY-MM-DD, inclusive
  endExclusive: string;  // YYYY-MM-DD, exclusive (Google all-day end)
  blockType: string | null;
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

export const CLEANING_AFTER_LATE_CHECKOUT_LABEL = 'Reinigung nach Late-Checkout';

/**
 * Zieltage des Folgetag-Blocks bei Late-Checkout (#793, korrigiert in #802): `planned_departure`
 * später als der Listing-Standard → Tag **Check-out + 1**. Guestys Vorbereitungszeit (`pt`) blockt
 * nur die Check-out-Nacht; unser Block (`next-day-block.ts`) liegt auf dem Folgetag. Lokal ist der
 * Grund NICHT gespeichert: `pt`-Tage kommen als `block_type null` an, unser Block als `'manual'`
 * (zwei getrennte 1-Nacht-Spans) — die Erkennung ist eine Heuristik: 1-Nacht-Block am
 * Check-out-Tag + 1 einer Late-Checkout-Reservierung.
 */
export function lateCheckoutDates(
  reservations: Array<{ status?: string; check_out: string; check_out_localized: string | null; planned_departure: string | null }>,
  defaultCheckOut: string | undefined,
): Set<string> {
  const out = new Set<string>();
  const std = defaultCheckOut?.slice(0, 5);
  if (!std) return out;
  for (const r of reservations) {
    const dep = r.planned_departure?.slice(0, 5);
    if (dep && dep > std) out.add(addOneDay((r.check_out_localized || r.check_out).split('T')[0]));
  }
  return out;
}

/** Build an all-day Google Calendar event for a blocked span. */
export function buildBlockEvent(
  span: BlockSpan,
  propertyName: string,
  provider: string,
  lateCheckoutDays?: Set<string>,
): calendar_v3.Schema$Event {
  const nights = nightsBetween(span.startDate, span.endExclusive);
  const source = PROVIDER_LABELS[provider] ?? provider;
  const isCleaning =
    !!lateCheckoutDays?.has(span.startDate) && nights === 1 && span.blockType !== 'reservation';
  return {
    summary: isCleaning ? CLEANING_AFTER_LATE_CHECKOUT_LABEL : blockLabel(span.blockType, provider),
    description: `Quelle: ${source} · ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} · ${ddmm(span.startDate)}–${ddmm(span.endExclusive)}`,
    location: propertyName,
    start: { date: span.startDate },
    end: { date: span.endExclusive },
    transparency: 'opaque',
    extendedProperties: { private: { kind: 'owner-block' } },
  };
}
