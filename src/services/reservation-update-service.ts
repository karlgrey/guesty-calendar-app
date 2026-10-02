/**
 * Reservation-Update-Service (#792) — Agent-API `PATCH /reservations/:id`.
 *
 * Änderungen an Daten, Gästezahl, geplanter An-/Abreisezeit und Early-Check-in/
 * Late-Checkout (mit Folgetag-Block) allein über die Agent-API, ohne Guesty-Dashboard.
 *
 * Ablauf: Body validieren (Formate, unbekannte Felder) -> Guesty-Reservierung lesen ->
 * Guards (Status, Kanal, Datumsreihenfolge, Property-Max) -> Dates-Call (falls Datums-/
 * Zeit-Felder) -> Guests-Call (falls guestsCount) -> frisch lesen, lokal spiegeln.
 * Dates laufen immer VOR Guests: scheitert Dates, bleibt die Gästezahl unberührt.
 */
import { guestyClient } from './guesty-client.js';
import { mirrorReservationLocally } from './reservation-service.js';
import { getListingById } from '../repositories/listings-repository.js';
import { ValidationError, ConflictError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export const UPDATE_ALLOWED_FIELDS = [
  'checkIn', 'checkOut', 'guestsCount', 'plannedArrival', 'plannedDeparture', 'lateCheckOut', 'earlyCheckIn',
] as const;

/** Nur diese Stati sind änderbar (Hold bzw. bestätigt). */
const EDITABLE_STATUSES = ['reserved', 'confirmed'];

/**
 * Direktbuchungen tragen bei Guesty `source: 'manual'` (so legt die App sie an,
 * `createReservation`); `direct` zusätzlich akzeptiert. Alles andere (airbnb2,
 * booking, expedia …) oder fehlende `source` gilt als Fremdkanal -> 409.
 */
const DIRECT_SOURCES = ['manual', 'direct'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface CheckOption { blockDay: boolean; addAdditionalFee?: boolean }

export interface UpdateReservationInput {
  checkIn?: string;
  checkOut?: string;
  guestsCount?: number;
  plannedArrival?: string;
  plannedDeparture?: string;
  lateCheckOut?: CheckOption;
  earlyCheckIn?: CheckOption;
}

export interface ReservationView {
  id: string;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  guestsCount: number | null;
  guestId: string | null;
  plannedArrival: string | null;
  plannedDeparture: string | null;
  source: string | null;
}

export interface UpdateReservationResult extends ReservationView {
  /** Gesamtsumme laut Guesty nach der Änderung (Kontrollwert, wie beim Anlegen). Fehlt bei `stale`. */
  actualTotal?: number;
  /**
   * true, wenn Guesty nach dem Update (und kurzem Poll) noch den alten Stand liefert:
   * die Mutation ist angenommen, die Antwort zeigt aber NICHT den neuen Zustand —
   * `GET …/:id` nachziehen. Lokal wird dann nichts gespiegelt (ETL zieht nach).
   */
  stale?: boolean;
}

/** Poll nach dem Update (Guesty verarbeitet u. U. asynchron, vgl. Create-Retry). */
export interface UpdatePollOptions { pollAttempts?: number; pollDelayMs?: number }
const DEFAULT_POLL: Required<UpdatePollOptions> = { pollAttempts: 5, pollDelayMs: 2000 };

/**
 * Spiegelt der Guesty-Read die angefragten Werte? Verglichen werden nur Felder,
 * die der GET sicher liefert (Daten, Gästezahl) — Zeiten/Blöcke nicht.
 */
function reflectsInput(r: any, input: UpdateReservationInput): boolean {
  if (input.checkIn !== undefined && r?.checkInDateLocalized !== input.checkIn) return false;
  if (input.checkOut !== undefined && r?.checkOutDateLocalized !== input.checkOut) return false;
  if (input.guestsCount !== undefined && r?.guestsCount !== input.guestsCount) return false;
  return true;
}

/** Shape von `GET /api/agent/reservations/:id` (auch Basis der PATCH-Antwort). */
export function toReservationView(r: any, fallbackId: string): ReservationView {
  return {
    id: r?._id ?? fallbackId,
    status: r?.status ?? null,
    checkIn: r?.checkInDateLocalized ?? null,
    checkOut: r?.checkOutDateLocalized ?? null,
    guestsCount: r?.guestsCount ?? null,
    guestId: r?.guest?._id ?? r?.guestId ?? null,
    plannedArrival: r?.plannedArrival ?? null,
    plannedDeparture: r?.plannedDeparture ?? null,
    source: r?.source ?? null,
  };
}

function checkOption(name: string, v: unknown): { blockDay: boolean; addAdditionalFee: boolean } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ValidationError(`${name} muss ein Objekt {blockDay, addAdditionalFee?} sein`);
  }
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'blockDay' && k !== 'addAdditionalFee');
  if (extra.length > 0) throw new ValidationError(`${name}: unbekannte Felder ${extra.join(', ')} — erlaubt: blockDay, addAdditionalFee`);
  if (typeof o.blockDay !== 'boolean') throw new ValidationError(`${name}.blockDay muss true/false sein`);
  if (o.addAdditionalFee !== undefined && typeof o.addAdditionalFee !== 'boolean') {
    throw new ValidationError(`${name}.addAdditionalFee muss true/false sein`);
  }
  return { blockDay: o.blockDay, addAdditionalFee: o.addAdditionalFee ?? false };
}

function validateBody(body: unknown): UpdateReservationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(`Body muss ein JSON-Objekt sein — erlaubt: ${UPDATE_ALLOWED_FIELDS.join(', ')}`);
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !(UPDATE_ALLOWED_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(`Unbekannte Felder: ${unknown.join(', ')} — erlaubt: ${UPDATE_ALLOWED_FIELDS.join(', ')}`);
  }
  if (Object.keys(b).length === 0) {
    throw new ValidationError(`Body ist leer — erlaubt: ${UPDATE_ALLOWED_FIELDS.join(', ')}`);
  }
  for (const f of ['checkIn', 'checkOut'] as const) {
    if (b[f] !== undefined && (typeof b[f] !== 'string' || !DATE_RE.test(b[f] as string))) {
      throw new ValidationError(`${f} must be YYYY-MM-DD`);
    }
  }
  for (const f of ['plannedArrival', 'plannedDeparture'] as const) {
    if (b[f] !== undefined && (typeof b[f] !== 'string' || !TIME_RE.test(b[f] as string))) {
      throw new ValidationError(`${f} must be HH:MM (00:00–23:59)`);
    }
  }
  if (b.guestsCount !== undefined && (!Number.isInteger(b.guestsCount) || (b.guestsCount as number) < 1)) {
    throw new ValidationError('guestsCount must be a positive integer');
  }
  const input: UpdateReservationInput = {
    checkIn: b.checkIn as string | undefined,
    checkOut: b.checkOut as string | undefined,
    guestsCount: b.guestsCount as number | undefined,
    plannedArrival: b.plannedArrival as string | undefined,
    plannedDeparture: b.plannedDeparture as string | undefined,
  };
  if (b.lateCheckOut !== undefined) input.lateCheckOut = checkOption('lateCheckOut', b.lateCheckOut);
  if (b.earlyCheckIn !== undefined) input.earlyCheckIn = checkOption('earlyCheckIn', b.earlyCheckIn);
  return input;
}

export async function updateReservation(
  reservationId: string,
  body: unknown,
  opts: UpdatePollOptions = {},
): Promise<UpdateReservationResult> {
  const input = validateBody(body);

  const current = await guestyClient.getReservation(reservationId);

  const status: string = current?.status ?? 'unknown';
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new ConflictError(`Reservierung im Status '${status}' ist nicht änderbar (nur ${EDITABLE_STATUSES.join('/')})`);
  }
  const source: string | null = current?.source ?? null;
  if (!source || !DIRECT_SOURCES.includes(source.toLowerCase())) {
    throw new ConflictError(
      `Reservierung stammt aus Kanal '${source ?? 'unbekannt'}' — im Ursprungskanal ändern (Direktbuchungen: ${DIRECT_SOURCES.join('/')})`,
    );
  }

  const listingId: string | undefined = current?.listingId;
  const effIn = input.checkIn ?? current?.checkInDateLocalized;
  const effOut = input.checkOut ?? current?.checkOutDateLocalized;
  if ((input.checkIn || input.checkOut) && effIn && effOut && effOut <= effIn) {
    throw new ValidationError('checkOut must be after checkIn');
  }
  if (input.guestsCount !== undefined && listingId) {
    const max = getListingById(listingId)?.accommodates;
    if (max && input.guestsCount > max) {
      throw new ValidationError(`Property accommodates maximum ${max} guests`);
    }
  }

  const datesBody: Parameters<typeof guestyClient.updateReservationDates>[1] = {
    ...(input.checkIn ? { checkInDateLocalized: input.checkIn } : {}),
    ...(input.checkOut ? { checkOutDateLocalized: input.checkOut } : {}),
    ...(input.plannedArrival ? { plannedArrival: input.plannedArrival } : {}),
    ...(input.plannedDeparture ? { plannedDeparture: input.plannedDeparture } : {}),
    ...(input.earlyCheckIn ? { earlyCheckIn: input.earlyCheckIn as Required<CheckOption> } : {}),
    ...(input.lateCheckOut ? { lateCheckOut: input.lateCheckOut as Required<CheckOption> } : {}),
  };
  if (Object.keys(datesBody).length > 0) {
    await guestyClient.updateReservationDates(reservationId, datesBody);
  }
  if (input.guestsCount !== undefined) {
    await guestyClient.updateReservationGuests(reservationId, { guestsCount: input.guestsCount });
  }
  logger.info({ reservationId, fields: Object.keys(body as object) }, 'Reservation updated via agent API');

  // Guesty ist durch — frisch lesen. Der Read direkt nach dem PUT kann noch den
  // alten Stand liefern (Guesty asynchron, wie beim Create): kurz pollen, bis
  // Daten/Gästezahl angekommen sind; bleibt es alt, ehrlich `stale: true`
  // antworten statt alte Werte als Erfolg auszugeben (Review-Gate #792).
  const { pollAttempts, pollDelayMs } = { ...DEFAULT_POLL, ...opts };
  let fresh = await guestyClient.getReservation(reservationId);
  for (let attempt = 1; !reflectsInput(fresh, input) && attempt < pollAttempts; attempt++) {
    logger.warn({ reservationId, attempt, pollAttempts }, 'Guesty liefert nach dem Update noch den alten Stand, warte');
    await new Promise((res) => setTimeout(res, pollDelayMs));
    fresh = await guestyClient.getReservation(reservationId);
  }
  if (!reflectsInput(fresh, input)) {
    logger.warn({ reservationId, pollAttempts }, 'Guesty-Reservierung nach Update weiterhin alt — Antwort stale, kein lokales Spiegeln');
    return { ...toReservationView(fresh, reservationId), stale: true };
  }

  // Lokal nachziehen (best effort: ein Problem hier darf die Antwort nicht zum
  // Fehler machen, der ETL zieht ohnehin nach).
  let actualTotal: number | undefined;
  try {
    if (listingId) {
      actualTotal = await mirrorReservationLocally(reservationId, listingId, {
        checkIn: effIn, checkOut: effOut,
        guestsCount: input.guestsCount ?? current?.guestsCount ?? 1,
        guest: { firstName: current?.guest?.fullName ?? '', lastName: '' },
      }, fresh);
    }
  } catch (error) {
    logger.warn({ error, reservationId }, 'Lokales Spiegeln nach Update fehlgeschlagen (Guesty-Update war erfolgreich)');
  }
  if (actualTotal === undefined) {
    const m = fresh?.money;
    if (m) actualTotal = m.hostPayout ?? ((m.subTotalPrice ?? 0) + (m.totalTaxes ?? 0));
  }

  return { ...toReservationView(fresh, reservationId), ...(actualTotal !== undefined ? { actualTotal } : {}) };
}
