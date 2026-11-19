/**
 * #1099: Adapter Guesty Reservations v3 → bisherige Form der Legacy-API (`GET /reservations`,
 * `GET /reservations/{id}`, abgeschaltet von Guesty am 01.03.2027).
 *
 * Reine Funktionen, keine I/O. Der Client (guesty-client.ts) holt die Rohantworten
 * (`/reservations-v3?reservationIds[]=…`, `/reservations-v3/search`, `/payments`,
 * `/guests-crud/{id}`) und baut daraus mit diesen Funktionen das Objekt, das alle Aufrufer
 * bisher bekamen. Feldzuordnung belegt durch die Live-Probe 19.11.2026 (Fixtures
 * `src/test-fixtures/guesty-v3/`, Vertragstests `guesty-v3-adapter.test.ts`):
 *
 * - `money` des v3-Einzelabrufs ist wertgleich zur Legacy-API, es fehlen nur die
 *   Zahlungsfelder → aus `GET /payments?reservationId=` (balanceDue, totalPaid, …).
 * - `listingId` → `money.listingId` (Einzelabruf) bzw. `stay[0].listingId` (search).
 * - `guestsCount`, `numberOfGuests`, lokalisierte Daten → `stay[0]`.
 * - `guestId` → `bookerId` (Einzelabruf) bzw. `guestId` (search); `guest` nur über guests-crud.
 * - ACHTUNG Zeitstempel: v3 liefert `stay[].eta/etd` und die search-Felder `checkIn/checkOut`
 *   als lokale Uhrzeit des Objekts mit angehängtem `Z` (Probe: Farmhouse Juni 08:00 → v3
 *   `08:00:00.000Z`, Legacy `06:00:00.000Z`; U19 November 15:00 → v3 `15:00Z`, Legacy `14:00Z`),
 *   obwohl die Guesty-Doku „UTC" schreibt. Legacy `checkIn/checkOut` waren echte UTC-Instants
 *   (so stehen sie auch in `reservations.check_in`) → Umrechnung mit der Zeitzone des Objekts.
 *   `plannedArrival/plannedDeparture` (HH:MM) = Uhrzeit-Teil von `eta/etd`.
 */
import { fromZonedTime } from 'date-fns-tz';

/** Antwort `GET /payments?reservationId=<id>` (nur die genutzten Felder). */
export interface GuestyPaymentsSummary {
  balanceDue?: number;
  paymentsDue?: number;
  totalPaid?: number;
  totalRefunded?: number;
  totalPaymentFees?: number;
  isFullyPaid?: boolean;
  payments?: unknown[];
}

/** Gast-Teilobjekt wie es die Legacy-Reservierung trug (`guest`). */
export interface LegacyGuestSummary {
  _id: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
}

const PAYMENT_FIELDS = ['balanceDue', 'paymentsDue', 'totalPaid', 'totalRefunded', 'totalPaymentFees', 'isFullyPaid', 'payments'] as const;

const WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z?$/;

/**
 * v3-„Wanduhr"-Zeitstempel (`2027-06-26T08:00:00.000Z` = 08:00 Ortszeit) → echter UTC-Instant.
 * Ohne Zeitzone oder bei unlesbarem Wert: unverändert zurück (kein Raten einer Zone).
 */
export function wallClockToUtcIso(value: string | null | undefined, timezone: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const m = WALL_CLOCK_RE.exec(value);
  if (!m || !timezone) return value;
  const local = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}`;
  const d = fromZonedTime(local, timezone);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/** Uhrzeit-Teil `HH:MM` eines v3-Wanduhr-Zeitstempels (`eta`/`etd`), sonst undefined. */
export function wallClockHhmm(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = WALL_CLOCK_RE.exec(value);
  return m ? `${m[2]}:${m[3]}` : undefined;
}

/** Nächte zwischen zwei lokalisierten Daten (YYYY-MM-DD); undefined bei fehlenden/kaputten Daten. */
export function nightsBetweenLocalDates(checkIn: string | undefined, checkOut: string | undefined): number | undefined {
  if (!checkIn || !checkOut) return undefined;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

/** guests-crud-Antwort → Legacy-`guest`-Teilobjekt (Name, erste Mail/Telefonnummer). */
export function toLegacyGuest(g: any): LegacyGuestSummary | undefined {
  if (!g?._id) return undefined;
  const first = (xs: unknown): string | undefined =>
    Array.isArray(xs) ? xs.find((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
  const out: LegacyGuestSummary = { _id: g._id };
  if (g.firstName) out.firstName = g.firstName;
  if (g.lastName) out.lastName = g.lastName;
  if (g.fullName) out.fullName = g.fullName;
  const email = typeof g.email === 'string' && g.email ? g.email : first(g.emails);
  const phone = typeof g.phone === 'string' && g.phone ? g.phone : first(g.phones);
  if (email) out.email = email;
  if (phone) out.phone = phone;
  return out;
}

function firstStay(r: any): any {
  return Array.isArray(r?.stay) && r.stay.length > 0 ? r.stay[0] : {};
}

/**
 * Einzelabruf `GET /reservations-v3?reservationIds[]=<id>` (ein Array-Element) → Legacy-Form
 * von `GET /reservations/{id}`. `payments` (aus `/payments`) ergänzt die fehlenden
 * Zahlungsfelder im money-Objekt, `guest` (aus guests-crud) das fehlende Gast-Objekt.
 * `timezoneFor(listingId)` liefert die IANA-Zone des Objekts für checkIn/checkOut.
 */
export function adaptV3Reservation(
  v3: any,
  opts: {
    payments?: GuestyPaymentsSummary | null;
    guest?: any;
    timezoneFor?: (listingId: string | undefined) => string | null | undefined;
  } = {},
): any {
  const stay = firstStay(v3);
  const listingId: string | undefined = v3?.listingId ?? v3?.money?.listingId ?? stay.listingId ?? stay.unitId ?? undefined;
  const tz = opts.timezoneFor?.(listingId) ?? null;
  const checkInDateLocalized: string | undefined = stay.checkInDateLocalized ?? v3?.checkInDateLocalized;
  const checkOutDateLocalized: string | undefined = stay.checkOutDateLocalized ?? v3?.checkOutDateLocalized;

  const money = v3?.money ? { ...v3.money } : undefined;
  if (money && opts.payments) {
    for (const k of PAYMENT_FIELDS) {
      if (opts.payments[k] !== undefined) (money as any)[k] = opts.payments[k];
    }
  }

  const guestId: string | undefined = v3?.guestId ?? v3?.bookerId ?? v3?.guests?.[0]?.id ?? undefined;
  const guest = toLegacyGuest(opts.guest);

  const out: any = {
    ...v3,
    _id: v3?._id ?? v3?.reservationId,
    listingId,
    checkIn: wallClockToUtcIso(stay.eta ?? v3?.checkIn, tz) ?? checkInDateLocalized,
    checkOut: wallClockToUtcIso(stay.etd ?? v3?.checkOut, tz) ?? checkOutDateLocalized,
    checkInDateLocalized,
    checkOutDateLocalized,
    nightsCount: nightsBetweenLocalDates(checkInDateLocalized, checkOutDateLocalized),
    guestsCount: stay.guestsCount ?? v3?.guestsCount,
    numberOfGuests: stay.numberOfGuests ?? v3?.numberOfGuests,
    plannedArrival: wallClockHhmm(stay.eta),
    plannedDeparture: wallClockHhmm(stay.etd),
    guestId,
    integration: v3?.integration ?? { _id: v3?.integrationId, platform: v3?.platform },
  };
  if (money) out.money = money;
  if (guest) out.guest = guest;
  else delete out.guest;
  return out;
}

/**
 * Listeneintrag von `GET /reservations-v3/search` → Legacy-Listenform (Felder, die die
 * Aufrufer der alten Liste lasen: _id, listingId, status, checkIn/checkOut, lokalisierte
 * Daten, guestsCount, source, createdAt, confirmationCode, guestId). search liefert KEIN
 * money und KEIN guest-Objekt — die ergänzt der Aufrufer bei Bedarf (sync-inquiries.ts).
 */
export function adaptV3SearchResult(
  item: any,
  opts: { timezoneFor?: (listingId: string | undefined) => string | null | undefined } = {},
): any {
  const stay = firstStay(item);
  const listingId: string | undefined = stay.listingId ?? item?.listingId ?? undefined;
  const tz = opts.timezoneFor?.(listingId) ?? null;
  const checkInDateLocalized: string | undefined = item?.checkInDateLocalized ?? stay.checkInDateLocalized;
  const checkOutDateLocalized: string | undefined = item?.checkOutDateLocalized ?? stay.checkOutDateLocalized;
  return {
    _id: item?.reservationId ?? item?._id,
    listingId,
    status: item?.status,
    checkIn: wallClockToUtcIso(item?.checkIn ?? stay.checkIn, tz) ?? checkInDateLocalized,
    checkOut: wallClockToUtcIso(item?.checkOut ?? stay.checkOut, tz) ?? checkOutDateLocalized,
    checkInDateLocalized,
    checkOutDateLocalized,
    guestsCount: stay.guestsCount ?? item?.guestsCount,
    numberOfGuests: stay.numberOfGuests,
    guestId: item?.guestId,
    source: item?.source,
    createdAt: item?.createdAt,
    confirmationCode: item?.confirmationCode,
    ...(item?.notes !== undefined ? { notes: item.notes } : {}),
  };
}
