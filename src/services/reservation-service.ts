/**
 * Reservation Service — Angebots-Workflow für Direktanfragen (Agent-API + Admin-Form).
 *
 * Erstellt Gast + Hold-Reservierung (status 'reserved', reservedUntil -1) in Guesty
 * und erzeugt das Angebots-PDF über den bestehenden document-service.
 * Reihenfolge bewusst: erst Reservierung, dann Dokument — so wird nie eine
 * Angebotsnummer verbrannt, wenn Guesty ablehnt. Schlägt umgekehrt das Dokument
 * fehl, bleibt die Reservierung stehen (documentError in der Antwort; Angebot
 * lässt sich über den Admin-Flow nachziehen).
 *
 * Spec: docs/superpowers/specs/2026-07-24-agent-reservierung-design.md
 */
import { guestyClient } from './guesty-client.js';
import { createOrGetDocument } from './document-service.js';
import { areDatesAvailable } from '../repositories/availability-repository.js';
import { upsertReservation } from '../repositories/reservation-repository.js';
import { getPropertyBySlug } from '../config/properties.js';
import { ValidationError, ConflictError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface CreateOfferInput {
  propertySlug: string;
  checkIn: string;
  checkOut: string;
  guestsCount: number;
  guest: { firstName: string; lastName: string; email: string; phone?: string };
  priceGross?: number;
  cleaningFee?: number;
  holdUntil?: string;
}

export interface CreateOfferResult {
  reservationId: string;
  guestId: string;
  documentNumber: string;
  holdUntil: string;
  priceSource: 'manual' | 'quote';
  documentError?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOLD_DEFAULT_DAYS = 14;

function validate(input: CreateOfferInput): { listingId: string } {
  const prop = getPropertyBySlug(input.propertySlug);
  if (!prop) throw new ValidationError(`Unknown property: ${input.propertySlug}`);
  if (prop.provider !== 'guesty' || !prop.guestyPropertyId) {
    throw new ValidationError(`Property ${input.propertySlug} is not a Guesty property`);
  }
  if (!DATE_RE.test(input.checkIn) || !DATE_RE.test(input.checkOut)) {
    throw new ValidationError('checkIn/checkOut must be YYYY-MM-DD');
  }
  if (input.checkOut <= input.checkIn) throw new ValidationError('checkOut must be after checkIn');
  if (!Number.isInteger(input.guestsCount) || input.guestsCount < 1) {
    throw new ValidationError('guestsCount must be a positive integer');
  }
  if (!input.guest?.firstName || !input.guest?.lastName || !input.guest?.email) {
    throw new ValidationError('guest.firstName, guest.lastName and guest.email are required');
  }
  if (input.priceGross !== undefined && !(input.priceGross > 0)) {
    throw new ValidationError('priceGross must be > 0');
  }
  if (input.cleaningFee !== undefined && !(input.cleaningFee >= 0)) {
    throw new ValidationError('cleaningFee must be >= 0');
  }
  if (input.holdUntil !== undefined && !DATE_RE.test(input.holdUntil)) {
    throw new ValidationError('holdUntil must be YYYY-MM-DD');
  }
  return { listingId: prop.guestyPropertyId };
}

export async function createOfferReservation(input: CreateOfferInput): Promise<CreateOfferResult> {
  const { listingId } = validate(input);

  // Lokaler Verfügbarkeits-Check (schnelles 409); Guesty prüft beim Anlegen
  // nochmal autoritativ (ignoreCalendar bleibt false).
  if (!areDatesAvailable(listingId, input.checkIn, input.checkOut)) {
    throw new ConflictError(`Dates not available: ${input.checkIn}..${input.checkOut}`);
  }

  const holdUntil = input.holdUntil
    ?? new Date(Date.now() + HOLD_DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const guestId = await guestyClient.createGuest(input.guest);
  const reservationId = await guestyClient.createReservation({
    listingId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guestsCount: input.guestsCount,
    guestId,
    status: 'reserved',
    ...(input.priceGross !== undefined ? { accommodationFare: input.priceGross } : {}),
    ...(input.cleaningFee !== undefined ? { cleaningFee: input.cleaningFee } : {}),
  });

  const result: CreateOfferResult = {
    reservationId,
    guestId,
    documentNumber: '',
    holdUntil,
    priceSource: input.priceGross !== undefined ? 'manual' : 'quote',
  };

  try {
    // Reservierung sofort lokal spiegeln: documents.reservation_id hat einen
    // FK auf die lokale reservations-Tabelle, der ETL zieht erst ~1 h später
    // nach (Befund Smoke-Test 24.07.2026 — sonst "FOREIGN KEY constraint failed").
    await mirrorReservationLocally(reservationId, listingId, input);
    const doc = await createOrGetDocument({ reservationId, documentType: 'quote' });
    result.documentNumber = doc.document.documentNumber;
  } catch (err) {
    // Reservierung NICHT stornieren — Angebot kann über den Admin-Flow nachgezogen werden.
    result.documentError = err instanceof Error ? err.message : String(err);
    logger.error({ err, reservationId }, 'Offer document creation failed after reservation was created');
  }

  logger.info({ reservationId, guestId, holdUntil, priceSource: result.priceSource }, 'Offer reservation created');
  return result;
}

/**
 * Frische Guesty-Reservierung in die lokale reservations-Tabelle spiegeln
 * (Voraussetzung für den documents-FK; der reguläre ETL überschreibt die Zeile
 * später mit seinem vollständigeren Mapping).
 */
/**
 * Guesty verarbeitet V3-Creates asynchron — ein sofortiger Read liefert u. U.
 * 404 (Befund Smoke-Test 24.07.2026). Bis zu ~18 s pollen, dann aufgeben.
 */
async function getReservationWithRetry(reservationId: string, attempts = 6, delayMs = 3000): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await guestyClient.getReservation(reservationId);
    } catch (err) {
      lastErr = err;
      logger.warn({ reservationId, attempt: i + 1, attempts }, 'Reservation not yet readable, retrying');
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
}

async function mirrorReservationLocally(
  reservationId: string,
  listingId: string,
  input: CreateOfferInput,
): Promise<void> {
  const r = await getReservationWithRetry(reservationId);
  const nights = Math.max(
    1,
    Math.round((new Date(input.checkOut).getTime() - new Date(input.checkIn).getTime()) / (24 * 60 * 60 * 1000)),
  );
  upsertReservation({
    reservation_id: reservationId,
    listing_id: listingId,
    check_in: r?.checkIn ?? input.checkIn,
    check_out: r?.checkOut ?? input.checkOut,
    check_in_localized: r?.checkInDateLocalized ?? input.checkIn,
    check_out_localized: r?.checkOutDateLocalized ?? input.checkOut,
    nights_count: nights,
    guest_id: r?.guestId ?? null,
    guest_name: `${input.guest.firstName} ${input.guest.lastName}`,
    guests_count: input.guestsCount,
    adults_count: input.guestsCount,
    children_count: null,
    infants_count: null,
    status: r?.status ?? 'reserved',
    confirmation_code: r?.confirmationCode ?? null,
    source: 'manual',
    platform: 'direct',
    planned_arrival: null,
    planned_departure: null,
    currency: r?.money?.currency ?? 'EUR',
    total_price: r?.money?.totalPrice ?? r?.money?.subTotalPrice ?? null,
    host_payout: r?.money?.hostPayout ?? null,
    balance_due: r?.money?.balanceDue ?? null,
    total_paid: r?.money?.totalPaid ?? 0,
    created_at_guesty: r?.createdAt ?? null,
    reserved_at: r?.reservedAt ?? new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    internal_guest_id: null,
    guest_company: null,
  });
}

export async function confirmOfferReservation(reservationId: string): Promise<void> {
  await guestyClient.updateReservationStatus(reservationId, 'confirmed');
}

export async function releaseOfferReservation(reservationId: string): Promise<void> {
  // Holds sind bei Guesty nicht 'canceled'-bar — Freigabe = 'expired'
  // (Smoke-Test 24.07.2026).
  await guestyClient.updateReservationStatus(reservationId, 'expired');
}
