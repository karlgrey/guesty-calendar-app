/**
 * Guesty-Kalender-Blocker (#1167) — reine Logik für GET/POST /api/agent/availability/:slug
 * bei provider=guesty: Tage klassifizieren, Bereiche gruppieren, Schreibplan bilden.
 *
 * Block-Typen laut Guesty-Doku „Calendar Block Types": m = manuell, b = Reservierung,
 * r = reserviert, o = Owner-Reservierung, pt = Vorbereitungszeit, bd/sr/abl/a/bw/an/ic = Regeln.
 * Live-Befund #799/#802: ein Listing-Kalender-PUT `available` entfernt AUCH pt-Blöcke —
 * deshalb fasst unblock ausschließlich reine `m`-Tage an.
 */

import type { GuestyCalendarDay } from '../types/guesty.js';

export type GuestyBlockType = 'manual' | 'late-checkout' | 'reservation' | 'hold' | 'other';

export interface GuestyAvailabilityDay {
  date: string;
  available: boolean;
  /** null = frei */
  blockType: GuestyBlockType | null;
  /** Roh-Typen der blockRefs (bzw. gesetzte Flags, wenn keine blockRefs da sind) */
  blockTypes: string[];
  remarks: string;
  reservationId?: string;
}

export interface GuestyBlockedRange {
  from: string;
  to: string;
  nights: number;
  remarks: string;
  blockType: GuestyBlockType;
  reservationId?: string;
}

/** Notiz-Präfix unserer Folgetag-Blöcke (next-day-block.ts, #799/#802). */
const LATE_CHECKOUT_NOTE = 'Late-Checkout ';
const HOLD_STATUSES = new Set(['reserved', 'inquiry', 'awaiting_payment']);
const RESERVATION_TYPES = new Set(['b', 'r', 'o']);

function flagTypes(blocks: GuestyCalendarDay['blocks']): string[] {
  return Object.entries(blocks ?? {}).filter(([, v]) => v === true).map(([k]) => k);
}

export function classifyGuestyDay(d: GuestyCalendarDay): GuestyAvailabilityDay {
  const date = String(d.date).split('T')[0];
  const refs = d.blockRefs ?? [];
  const notes = [d.note, ...refs.map((r) => r.note)].filter((n): n is string => typeof n === 'string' && n !== '');
  const remarks = notes[0] ?? '';
  const isAvailable = typeof d.allotment === 'number' ? d.allotment > 0 : d.status === 'available';
  const blockTypes = refs.length > 0 ? [...new Set(refs.map((r) => r.type))] : flagTypes(d.blocks);

  if (isAvailable) return { date, available: true, blockType: null, blockTypes, remarks };

  const resRef = refs.find((r) => r.reservation || r.reservationId);
  if (resRef || blockTypes.some((t) => RESERVATION_TYPES.has(t))) {
    const reservationId = resRef?.reservation?._id ?? resRef?.reservationId;
    const status = resRef?.reservation?.status;
    const isHold = (status !== undefined && HOLD_STATUSES.has(status)) || (!resRef && blockTypes.includes('r') && !blockTypes.includes('b'));
    return {
      date, available: false, blockType: isHold ? 'hold' : 'reservation', blockTypes, remarks,
      ...(reservationId ? { reservationId } : {}),
    };
  }

  if (blockTypes.length > 0 && blockTypes.every((t) => t === 'm')) {
    const lateCheckout = notes.some((n) => n.startsWith(LATE_CHECKOUT_NOTE));
    return { date, available: false, blockType: lateCheckout ? 'late-checkout' : 'manual', blockTypes, remarks };
  }
  return { date, available: false, blockType: 'other', blockTypes, remarks };
}

/** Aufeinanderfolgende gesperrte Tage mit gleichem Typ (und gleicher Reservierung) zu Bereichen. */
export function groupGuestyBlockedRanges(days: GuestyAvailabilityDay[]): GuestyBlockedRange[] {
  const ranges: GuestyBlockedRange[] = [];
  let cur: GuestyBlockedRange | null = null;
  for (const d of days) {
    if (d.available || d.blockType === null) { if (cur) { ranges.push(cur); cur = null; } continue; }
    if (cur && cur.blockType === d.blockType && cur.reservationId === d.reservationId && nextDay(cur.to) === d.date) {
      cur.to = d.date;
      cur.nights += 1;
      continue;
    }
    if (cur) ranges.push(cur);
    cur = {
      from: d.date, to: d.date, nights: 1, remarks: d.remarks, blockType: d.blockType,
      ...(d.reservationId ? { reservationId: d.reservationId } : {}),
    };
  }
  if (cur) ranges.push(cur);
  return ranges;
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Sortierte Tagesliste → lückenlose Läufe (je ein Guesty-PUT, Grenzen inklusiv). */
export function toRuns(dates: string[]): Array<{ from: string; to: string; nights: number }> {
  const runs: Array<{ from: string; to: string; nights: number }> = [];
  for (const date of dates) {
    const last = runs[runs.length - 1];
    if (last && nextDay(last.to) === date) { last.to = date; last.nights += 1; }
    else runs.push({ from: date, to: date, nights: 1 });
  }
  return runs;
}

export interface SkippedDay { date: string; blockType: GuestyBlockType | null; reason: string }

export interface GuestyMutationPlan {
  /** Tage, die geschrieben werden */
  write: string[];
  /** Tage, die schon im Zielzustand sind */
  unchanged: string[];
  /** Tage, die bewusst nicht angefasst werden */
  skipped: SkippedDay[];
  /** nur block: Tage mit Reservierung/Hold → 409 */
  conflicts: SkippedDay[];
}

function skipReason(d: GuestyAvailabilityDay): string {
  const types = d.blockTypes.join(', ') || 'unavailable';
  switch (d.blockType) {
    case 'reservation': return `Reservierung${d.reservationId ? ` ${d.reservationId}` : ''} — nicht angefasst`;
    case 'hold': return `Hold${d.reservationId ? ` ${d.reservationId}` : ''} — nicht angefasst`;
    case 'late-checkout': return 'Folgetag-Block nach Late-Checkout — über /reservations/:id/times verwalten';
    default: return `kein manueller Block (${types}) — nicht angefasst`;
  }
}

export function planGuestyMutation(
  days: GuestyAvailabilityDay[],
  action: 'block' | 'unblock',
  todayBerlin: string,
): GuestyMutationPlan {
  const plan: GuestyMutationPlan = { write: [], unchanged: [], skipped: [], conflicts: [] };
  for (const d of days) {
    if (d.date < todayBerlin) {
      plan.skipped.push({ date: d.date, blockType: d.blockType, reason: 'Tag liegt in der Vergangenheit' });
      continue;
    }
    const occupied = d.blockType === 'reservation' || d.blockType === 'hold';
    if (action === 'block' && occupied) {
      plan.conflicts.push({ date: d.date, blockType: d.blockType, reason: skipReason(d) });
      continue;
    }
    if (action === 'unblock') {
      if (d.available) plan.unchanged.push(d.date);
      else if (d.blockType === 'manual') plan.write.push(d.date);
      else plan.skipped.push({ date: d.date, blockType: d.blockType, reason: skipReason(d) });
    } else {
      if (d.available) plan.write.push(d.date);
      else if (d.blockType === 'manual') plan.unchanged.push(d.date);
      else plan.skipped.push({
        date: d.date, blockType: d.blockType,
        reason: `bereits geblockt (${d.blockTypes.join(', ') || 'unavailable'}) — nicht angefasst`,
      });
    }
  }
  return plan;
}
