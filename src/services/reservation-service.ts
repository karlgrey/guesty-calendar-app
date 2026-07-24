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

export async function confirmOfferReservation(reservationId: string): Promise<void> {
  await guestyClient.updateReservationStatus(reservationId, 'confirmed');
}

export async function releaseOfferReservation(reservationId: string): Promise<void> {
  await guestyClient.updateReservationStatus(reservationId, 'canceled');
}
