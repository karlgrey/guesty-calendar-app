/**
 * Folgetag-Block bei zugesagtem Late-Checkout (#799) — nur Objekte mit
 * `blocksNextDayOnLateCheckout` (Farmhouse). Alle anderen: kein Guesty-/Hostex-Aufruf.
 *
 * EIN Pfad für alle Guesty-Buchungen (Direkt und Kanal): der Listing-Kalender am Check-out-Tag.
 * Der Reservierungs-Pfad (`lateCheckOut.blockDay`) wird NICHT mehr benutzt — er setzt
 * `plannedDeparture` auf die Listing-Late-Checkout-Zeit (bleibt nach Rücknahme stehen) und
 * tauscht Guesty-Blöcke aus.
 *
 * Regeln (Live-Test 02.10.2026):
 * - Block nur setzen, wenn der Tag laut Kalender FREI ist. Guesty blockt den Folgetag am
 *   Farmhouse/U19 per Vorbereitungszeit (blockRef-Typ `pt`) ohnehin; ein PUT würde nur die
 *   Notiz setzen und die spätere Rücknahme den pt-Block entfernen.
 * - Rücknahme nur, wenn wir selbst geblockt haben (`previousState === 'set-by-us'`) UND der Tag
 *   genau unseren manuellen Block (`m`, Notiz `Late-Checkout <id>`) trägt.
 *
 * Fehler werden NICHT geworfen: der Aufrufer speichert den Override trotzdem (Marker ist
 * wichtiger als Block) und meldet `applied: false` + Grund.
 */
import { findPropertyByListingId } from '../config/properties.js';
import { guestyClient } from './guesty-client.js';
import { ExternalApiError } from '../utils/errors.js';
import type { BlockState } from '../repositories/stay-time-override-repository.js';
import type { GuestyCalendarDay } from '../types/guesty.js';
import logger from '../utils/logger.js';

export interface NextDayBlockTarget {
  reservationId: string;
  listingId: string;
  /** Check-out-Tag YYYY-MM-DD */
  checkOutDay: string;
}

export interface NextDayBlockResult {
  applied: boolean;
  method: 'listing-calendar' | 'none';
  reason?: string;
  /** Zustand zum Persistieren am Override (bei Fehler: der bisherige) */
  blockState: BlockState | null;
  /** nur bei Fehler: Anbietertext für den 409-Body */
  error?: { message: string; details?: unknown };
}

const noteFor = (reservationId: string) => `Late-Checkout ${reservationId}`;

function blockTypes(d: GuestyCalendarDay | undefined): string[] {
  return (d?.blockRefs ?? []).map((b) => b.type);
}

/** Tag trägt genau unseren manuellen Block mit unserer Notiz. */
function isOurBlock(d: GuestyCalendarDay | undefined, reservationId: string): boolean {
  if (!d || d.status !== 'unavailable') return false;
  const refs = d.blockRefs ?? [];
  if (refs.length === 0 || !refs.every((b) => b.type === 'm')) return false;
  const expected = noteFor(reservationId);
  return [d.note, ...refs.map((b) => b.note)].some((n) => typeof n === 'string' && n.startsWith(expected));
}

export async function applyNextDayBlock(
  target: NextDayBlockTarget,
  wanted: boolean,
  previousState: BlockState | null,
): Promise<NextDayBlockResult> {
  const property = findPropertyByListingId(target.listingId);
  if (!property?.blocksNextDayOnLateCheckout) {
    return { applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag', blockState: null };
  }

  const { reservationId, listingId, checkOutDay } = target;
  try {
    if (wanted) {
      const days = await guestyClient.getCalendar(listingId, checkOutDay, checkOutDay);
      const d = days.find((x) => x.date?.split('T')[0] === checkOutDay) ?? days[0];
      if (d && d.status !== 'available') {
        const types = blockTypes(d);
        logger.info({ reservationId, day: checkOutDay, types }, 'Folgetag bereits geblockt — kein Schreibaufruf');
        // Haben wir den Tag früher selbst geblockt, bleibt das so (Rücknahme darf ihn weiter lösen).
        const blockState: BlockState = previousState === 'set-by-us' && isOurBlock(d, reservationId) ? 'set-by-us' : 'already-blocked';
        return {
          applied: false, method: 'none',
          reason: `Folgetag bereits geblockt (${types.join(', ') || 'unavailable'})`,
          blockState,
        };
      }
      await guestyClient.setListingCalendarStatus(listingId, {
        startDate: checkOutDay, endDate: checkOutDay, status: 'unavailable', note: noteFor(reservationId),
      });
      logger.info({ reservationId, day: checkOutDay, method: 'listing-calendar' }, 'Folgetag geblockt');
      return { applied: true, method: 'listing-calendar', blockState: 'set-by-us' };
    }

    // Rücknahme: nur, was wir selbst gesetzt haben.
    if (previousState !== 'set-by-us') {
      return { applied: false, method: 'none', reason: 'kein Folgetag-Block von uns gesetzt', blockState: null };
    }
    const days = await guestyClient.getCalendar(listingId, checkOutDay, checkOutDay);
    const d = days.find((x) => x.date?.split('T')[0] === checkOutDay) ?? days[0];
    if (!isOurBlock(d, reservationId)) {
      logger.warn({ reservationId, day: checkOutDay, status: d?.status, types: blockTypes(d) }, 'Folgetag-Block nicht von uns / Tag anders belegt — nicht angefasst');
      return {
        applied: false, method: 'none',
        reason: 'Block nicht von uns gesetzt / Tag anders belegt — nicht angefasst',
        blockState: null,
      };
    }
    await guestyClient.setListingCalendarStatus(listingId, {
      startDate: checkOutDay, endDate: checkOutDay, status: 'available', note: '',
    });
    logger.info({ reservationId, day: checkOutDay, method: 'listing-calendar' }, 'Folgetag-Block aufgehoben');
    return { applied: true, method: 'listing-calendar', blockState: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof ExternalApiError ? err.details : undefined;
    logger.warn({ reservationId, method: 'listing-calendar', wanted, message, details }, 'Folgetag-Block bei Guesty fehlgeschlagen');
    return {
      applied: false,
      method: 'listing-calendar',
      reason: `Guesty-Aufruf fehlgeschlagen: ${message}`,
      blockState: previousState,
      error: { message, ...(details !== undefined ? { details } : {}) },
    };
  }
}
