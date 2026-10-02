/**
 * Folgetag-Block bei zugesagtem Late-Checkout (#799, korrigiert in #802) — nur Objekte mit
 * `blocksNextDayOnLateCheckout` (Farmhouse). Alle anderen: kein Guesty-/Hostex-Aufruf.
 *
 * EIN Pfad für alle Guesty-Buchungen (Direkt und Kanal): der Listing-Kalender am Zieltag
 * **Check-out + 1**. Guestys Vorbereitungszeit (`pt`) blockt am Farmhouse nur die Check-out-Nacht
 * (Check-out-Tag 12:00 bis Folgetag 12:00); bei Late-Checkout wird erst am Folgetag gereinigt,
 * dort darf kein Check-in stattfinden — und genau dieser Tag ist durch `pt` NICHT geblockt.
 * Immer genau EIN Tag. Der Reservierungs-Pfad (`lateCheckOut.blockDay`) wird NICHT benutzt — er
 * setzt `plannedDeparture` auf die Listing-Late-Checkout-Zeit (bleibt nach Rücknahme stehen) und
 * tauscht Guesty-Blöcke aus.
 *
 * Regeln:
 * - Block nur setzen, wenn der Zieltag laut Kalender FREI ist (sonst `already-blocked`, kein Schreibaufruf).
 * - Rücknahme nur, wenn wir selbst geblockt haben (`previous.state === 'set-by-us'`) UND der Tag
 *   genau unseren manuellen Block (`m`, Notiz `Late-Checkout <id>`) trägt. Tag = gespeichertes
 *   `block_date` (Migration 037), sonst Check-out + 1.
 * - Datumsänderung: liegt unser Block (`block_date`) auf einem anderen Tag als dem neuen Zieltag,
 *   wird bei `wanted` NICHT neu geblockt (nie zwei Tage) — Rücknahme gibt den alten Tag frei,
 *   danach kann neu gesetzt werden.
 *
 * Fehler werden NICHT geworfen: der Aufrufer speichert den Override trotzdem (Marker ist
 * wichtiger als Block) und meldet `applied: false` + Grund.
 */
import { findPropertyByListingId } from '../config/properties.js';
import { guestyClient } from './guesty-client.js';
import { ExternalApiError } from '../utils/errors.js';
import { addOneDay } from '../utils/date.js';
import type { BlockState } from '../repositories/stay-time-override-repository.js';
import type { GuestyCalendarDay } from '../types/guesty.js';
import logger from '../utils/logger.js';

export interface NextDayBlockTarget {
  reservationId: string;
  listingId: string;
  /** Check-out-Tag YYYY-MM-DD */
  checkOutDay: string;
}

/** Bisher persistierter Block-Zustand (Migration 036/037) */
export interface PreviousBlock {
  state: BlockState | null;
  blockDate: string | null;
}

export interface NextDayBlockResult {
  applied: boolean;
  method: 'listing-calendar' | 'none';
  reason?: string;
  /** Zustand zum Persistieren am Override (bei Fehler: der bisherige) */
  blockState: BlockState | null;
  /** Tag, auf den sich blockState bezieht (YYYY-MM-DD); null bei blockState null */
  blockDate: string | null;
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
  previous: PreviousBlock,
): Promise<NextDayBlockResult> {
  const property = findPropertyByListingId(target.listingId);
  if (!property?.blocksNextDayOnLateCheckout) {
    return { applied: false, method: 'none', reason: 'Objekt blockt keinen Folgetag', blockState: null, blockDate: null };
  }

  const { reservationId, listingId } = target;
  const blockDay = addOneDay(target.checkOutDay);
  const readDay = async (date: string) => {
    const days = await guestyClient.getCalendar(listingId, date, date);
    return days.find((x) => x.date?.split('T')[0] === date) ?? days[0];
  };
  try {
    if (wanted) {
      if (previous.state === 'set-by-us' && previous.blockDate && previous.blockDate !== blockDay) {
        logger.warn(
          { reservationId, oldDay: previous.blockDate, newDay: blockDay },
          'Reservierung verschoben, Folgetag-Block liegt noch auf altem Tag — nicht angefasst',
        );
        return {
          applied: false, method: 'none',
          reason: `Folgetag-Block liegt auf ${previous.blockDate} (Reservierung verschoben) — nicht angefasst`,
          blockState: 'set-by-us', blockDate: previous.blockDate,
        };
      }
      const d = await readDay(blockDay);
      if (d && d.status !== 'available') {
        const types = blockTypes(d);
        logger.info({ reservationId, day: blockDay, types }, 'Folgetag bereits geblockt — kein Schreibaufruf');
        // Haben wir den Tag früher selbst geblockt, bleibt das so (Rücknahme darf ihn weiter lösen).
        const blockState: BlockState = previous.state === 'set-by-us' && isOurBlock(d, reservationId) ? 'set-by-us' : 'already-blocked';
        return {
          applied: false, method: 'none',
          reason: `Folgetag bereits geblockt (${types.join(', ') || 'unavailable'})`,
          blockState, blockDate: blockDay,
        };
      }
      await guestyClient.setListingCalendarStatus(listingId, {
        startDate: blockDay, endDate: blockDay, status: 'unavailable', note: noteFor(reservationId),
      });
      logger.info({ reservationId, day: blockDay, method: 'listing-calendar' }, 'Folgetag geblockt');
      return { applied: true, method: 'listing-calendar', blockState: 'set-by-us', blockDate: blockDay };
    }

    // Rücknahme: nur, was wir selbst gesetzt haben — genau auf dem Tag, den wir geblockt haben.
    if (previous.state !== 'set-by-us') {
      return { applied: false, method: 'none', reason: 'kein Folgetag-Block von uns gesetzt', blockState: null, blockDate: null };
    }
    const releaseDay = previous.blockDate ?? blockDay;
    const d = await readDay(releaseDay);
    if (!isOurBlock(d, reservationId)) {
      logger.warn({ reservationId, day: releaseDay, status: d?.status, types: blockTypes(d) }, 'Folgetag-Block nicht von uns / Tag anders belegt — nicht angefasst');
      return {
        applied: false, method: 'none',
        reason: 'Block nicht von uns gesetzt / Tag anders belegt — nicht angefasst',
        blockState: null, blockDate: null,
      };
    }
    await guestyClient.setListingCalendarStatus(listingId, {
      startDate: releaseDay, endDate: releaseDay, status: 'available', note: '',
    });
    logger.info({ reservationId, day: releaseDay, method: 'listing-calendar' }, 'Folgetag-Block aufgehoben');
    return { applied: true, method: 'listing-calendar', blockState: null, blockDate: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof ExternalApiError ? err.details : undefined;
    logger.warn({ reservationId, method: 'listing-calendar', wanted, message, details }, 'Folgetag-Block bei Guesty fehlgeschlagen');
    return {
      applied: false,
      method: 'listing-calendar',
      reason: `Guesty-Aufruf fehlgeschlagen: ${message}`,
      blockState: previous.state,
      blockDate: previous.blockDate,
      error: { message, ...(details !== undefined ? { details } : {}) },
    };
  }
}
