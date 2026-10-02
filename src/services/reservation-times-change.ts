/**
 * Änderungserkennung An-/Abreise (#793) — PURE, kein I/O.
 *
 * `detectTimesChange` vergleicht den lokalen Stand vor/nach einem Schreibvorgang
 * (ETL-Upsert oder PATCH-Spiegel) und liefert das Ereignis `reservation.timesChanged`
 * als Rückgabewert; `buildTimesChangeMessages` formuliert daraus die kurzen Texte für
 * die Putzcrew (Wanja). Versand/Dedupe: reservation-times-notifier.ts.
 */

export type TimesField = 'check_in' | 'check_out' | 'planned_arrival' | 'planned_departure';

export interface TimesSnapshot {
  reservation_id: string;
  listing_id: string;
  status: string;
  check_in: string;
  check_out: string;
  check_in_localized: string | null;
  check_out_localized: string | null;
  planned_arrival: string | null;
  planned_departure: string | null;
}

export interface FieldChange { field: TimesField; from: string | null; to: string | null }

/** Ereignis `reservation.timesChanged` (lokale Funktion, kein Bus). */
export interface TimesChange {
  reservationId: string;
  listingId: string;
  changes: FieldChange[];
  before: TimesSnapshot;
  after: TimesSnapshot;
}

/** Nur Reservierungen mit diesen Stati lösen aus (Hold bzw. bestätigt). */
const NOTIFY_STATUSES = ['confirmed', 'reserved'];

const day = (localized: string | null, raw: string): string => (localized || raw).split('T')[0];
const time = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

function todayBerlin(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}

export function detectTimesChange(
  before: TimesSnapshot | null,
  after: TimesSnapshot,
  today: string = todayBerlin(),
): TimesChange | null {
  if (!before) return null;
  if (!NOTIFY_STATUSES.includes(after.status)) return null;
  if (day(after.check_in_localized, after.check_in) < today) return null;

  const pairs: Array<[TimesField, string | null, string | null]> = [
    ['check_in', day(before.check_in_localized, before.check_in), day(after.check_in_localized, after.check_in)],
    ['check_out', day(before.check_out_localized, before.check_out), day(after.check_out_localized, after.check_out)],
    ['planned_arrival', time(before.planned_arrival), time(after.planned_arrival)],
    ['planned_departure', time(before.planned_departure), time(after.planned_departure)],
  ];
  const changes = pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field, from, to }));
  if (changes.length === 0) return null;
  return { reservationId: after.reservation_id, listingId: after.listing_id, changes, before, after };
}

export interface MessageContext {
  objectLabel: string;
  defaultCheckIn: string | null;
  defaultCheckOut: string | null;
}

export interface TimesChangeMessage {
  /** Dedupe-Schlüssel (Migration 034): 'dates' | 'planned_arrival' | 'planned_departure'. */
  field: 'dates' | 'planned_arrival' | 'planned_departure';
  value: string;
  text: string;
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function parts(d: string): { y: number; m: number; d: number } {
  const [y, m, dd] = d.split('-').map(Number);
  return { y, m, d: dd };
}
const p2 = (n: number) => String(n).padStart(2, '0');
const ddmm = (d: string) => `${p2(parts(d).d)}.${p2(parts(d).m)}.`;
function weekdayDdmm(d: string): string {
  const { y, m, d: dd } = parts(d);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${ddmm(d)}`;
}
/** "01.–03.12." bei gleichem Monat, sonst "30.11.–02.12.". */
function range(a: string, b: string): string {
  const pa = parts(a), pb = parts(b);
  return pa.m === pb.m && pa.y === pb.y ? `${p2(pa.d)}.–${p2(pb.d)}.${p2(pb.m)}.` : `${ddmm(a)}–${ddmm(b)}`;
}

const SIGN = ' Micha';

export function buildTimesChangeMessages(change: TimesChange, ctx: MessageContext): TimesChangeMessage[] {
  const out: TimesChangeMessage[] = [];
  const { before, after } = change;
  const byField = new Map(change.changes.map((c) => [c.field, c]));

  if (byField.has('check_in') || byField.has('check_out')) {
    const nIn = day(after.check_in_localized, after.check_in);
    const nOut = day(after.check_out_localized, after.check_out);
    const oIn = day(before.check_in_localized, before.check_in);
    const oOut = day(before.check_out_localized, before.check_out);
    out.push({
      field: 'dates',
      value: `${nIn}/${nOut}`,
      text: `${ctx.objectLabel}: neu ${range(nIn, nOut)} (statt ${range(oIn, oOut)}).${SIGN}`,
    });
  }

  const planned = (
    field: 'planned_arrival' | 'planned_departure',
    dayStr: string,
    def: string | null,
    label: string,
    earlierWord: string,
    laterWord: string,
  ) => {
    const c = byField.get(field);
    if (!c || !c.to) return;
    const base = `${ctx.objectLabel}, ${weekdayDdmm(dayStr)}: ${label} ${c.to}`;
    const prev = c.from ?? def;
    let text: string;
    if (def && c.to === def) {
      text = `${base.replace(` ${c.to}`, ` wieder ${c.to}`)} (Standard).${SIGN}`;
    } else if (prev) {
      const word = c.to < prev ? earlierWord : laterWord;
      text = `${base} statt ${prev} (${word}).${SIGN}`;
    } else {
      text = `${base}.${SIGN}`;
    }
    out.push({ field, value: c.to, text });
  };

  planned('planned_arrival', day(after.check_in_localized, after.check_in), ctx.defaultCheckIn,
    'Check-in', 'früher Check-in', 'später Check-in');
  planned('planned_departure', day(after.check_out_localized, after.check_out), ctx.defaultCheckOut,
    'Check-out', 'früher Check-out', 'Late-Checkout');
  return out;
}
