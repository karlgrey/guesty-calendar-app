/**
 * Folgetag-Block bei zugesagtem Late-Checkout (#799) — nur Objekte mit
 * `blocksNextDayOnLateCheckout` (Farmhouse). Alle anderen: kein Guesty-/Hostex-Aufruf.
 *
 * - Direktbuchung (Guesty `source` manual/direct, Erkennung = `isDirectSource` aus dem
 *   #792-Guard): `updateReservation` mit `lateCheckOut.blockDay` (ohne Gebühr).
 * - Kanalbuchung (z. B. Airbnb am Farmhouse): `lateCheckOut.blockDay` greift dort nicht
 *   (Guard „im Ursprungskanal ändern") -> Listing-Kalender-Tag am Check-out-Tag blocken.
 *
 * Fehler werden NICHT geworfen: der Aufrufer speichert den Override trotzdem (Marker ist
 * wichtiger als Block) und meldet `applied: false` + Grund.
 */
import { findPropertyByListingId } from '../config/properties.js';
import { guestyClient } from './guesty-client.js';
import { updateReservation, isDirectSource } from './reservation-update-service.js';
import { ExternalApiError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface NextDayBlockTarget {
  reservationId: string;
  listingId: string;
  /** `reservations.source` (Guesty `source`, z. B. manual/airbnb2) */
  source: string | null;
  /** Check-out-Tag YYYY-MM-DD */
  checkOutDay: string;
}

export interface NextDayBlockResult {
  applied: boolean;
  method: 'reservation' | 'listing-calendar' | 'none';
  reason?: string;
  /** nur bei Fehler: Anbietertext für den 409-Body */
  error?: { message: string; details?: unknown };
}

export async function applyNextDayBlock(target: NextDayBlockTarget, wanted: boolean): Promise<NextDayBlockResult> {
  const property = findPropertyByListingId(target.listingId);
  if (!property?.blocksNextDayOnLateCheckout) {
    return { applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag' };
  }

  const direct = isDirectSource(target.source);
  const method = direct ? 'reservation' : 'listing-calendar';
  try {
    if (direct) {
      await updateReservation(target.reservationId, { lateCheckOut: { blockDay: wanted, addAdditionalFee: false } });
    } else {
      await guestyClient.setListingCalendarStatus(target.listingId, {
        startDate: target.checkOutDay,
        endDate: target.checkOutDay,
        status: wanted ? 'unavailable' : 'available',
        note: wanted ? `Late-Checkout ${target.reservationId}` : '',
      });
    }
    return { applied: true, method };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof ExternalApiError ? err.details : undefined;
    logger.warn({ reservationId: target.reservationId, method, wanted, message, details }, 'Folgetag-Block bei Guesty fehlgeschlagen');
    return {
      applied: false,
      method,
      reason: `Guesty-Aufruf fehlgeschlagen: ${message}`,
      error: { message, ...(details !== undefined ? { details } : {}) },
    };
  }
}
