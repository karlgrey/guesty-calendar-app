/**
 * #1234 (Fall Daniel): Einzelabruf der Anfragedaten beim Nachrichten-Eingang.
 *
 * syncInquiries läuft nur im Stunden-ETL. Bei einer frischen Guesty-Anfrage fehlt die
 * inquiries-Zeile deshalb bis zu einer Stunde — genau in dem Fenster, in dem Entwurf,
 * Auto-Send-Gate, Buchungsanfrage-Task und Michas erster Blick liegen. Hat der Thread eine
 * reservation_id/inquiry_id, aber weder eine reservations- noch eine inquiries-Zeile, holt
 * diese Funktion genau DIESE eine Reservierung per guestyClient.getReservation(id) und schreibt
 * sie mit demselben Mapper wie syncInquiries in inquiries.
 *
 * Wirft nie: Fehler, Rate-Limit oder Timeout werden geloggt, der Eingang läuft ohne Daten
 * weiter wie bisher. Kein Voll-Sync, je Aufruf eine Reservierung (seit #1099 zwei Guesty-Aufrufe:
 * v3-Einzelabruf + guests-crud für den Gastnamen).
 */
import { getThreadById } from '../repositories/message-repository.js';
import { getReservationById, getInquiryById } from '../repositories/reservation-repository.js';
import { guestyClient } from '../services/guesty-client.js';
import { upsertGuestyInquiries } from './sync-inquiries.js';
import type { MessageThread } from '../types/messages.js';
import logger from '../utils/logger.js';

/** Obergrenze für den Einzelabruf: der Client-Limiter kann bei 429 lange zurückstellen. */
export const INQUIRY_PREFETCH_TIMEOUT_MS = 15_000;

export type InquiryPrefetchOutcome =
  | 'no_thread'
  | 'not_linked'
  | 'exists'
  | 'fetched'
  | 'unusable'
  | 'failed';

export interface InquiryPrefetchDeps {
  getThread: (threadId: string) => MessageThread | null;
  hasReservation: (id: string) => boolean;
  hasInquiry: (id: string) => boolean;
  getReservation: (id: string) => Promise<any>;
  /** Schreibt die Reservierung nach inquiries; Rückgabe = Anzahl geschriebener Zeilen. */
  upsertInquiry: (reservation: any) => number;
  timeoutMs?: number;
}

const realDeps: InquiryPrefetchDeps = {
  getThread: getThreadById,
  hasReservation: (id) => getReservationById(id) !== null,
  hasInquiry: (id) => getInquiryById(id) !== null,
  // #1099: inquiries braucht money + Gastname, keinen Zahlungsstand (v3-Abruf + guests-crud)
  getReservation: (id) => guestyClient.getReservation(id, { payments: false }),
  upsertInquiry: (r) => upsertGuestyInquiries([r]),
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout nach ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function prefetchInquiryForThread(
  threadId: string,
  deps: InquiryPrefetchDeps = realDeps,
): Promise<InquiryPrefetchOutcome> {
  let id: string | null = null;
  try {
    const thread = deps.getThread(threadId);
    if (!thread) return 'no_thread';
    const ids = [...new Set([thread.inquiry_id, thread.reservation_id].filter((x): x is string => !!x))];
    if (ids.length === 0) return 'not_linked';
    if (ids.some((x) => deps.hasReservation(x) || deps.hasInquiry(x))) return 'exists';

    // Guesty-Anfragen tragen dieselbe Id in reservation_id UND inquiry_id; inquiry_id zuerst.
    id = ids[0];
    const start = Date.now();
    const reservation = await withTimeout(
      Promise.resolve().then(() => deps.getReservation(id!)),
      deps.timeoutMs ?? INQUIRY_PREFETCH_TIMEOUT_MS,
    );
    const written = deps.upsertInquiry(reservation);
    if (written === 0) {
      logger.warn({ threadId, reservationId: id }, 'inquiry-prefetch: Einzelabruf ohne verwertbare Daten (Pflichtfelder fehlen)');
      return 'unusable';
    }
    logger.info(
      {
        threadId,
        reservationId: id,
        status: reservation?.status ?? null,
        checkIn: reservation?.checkInDateLocalized ?? null,
        checkOut: reservation?.checkOutDateLocalized ?? null,
        guestsCount: reservation?.guestsCount ?? null,
        durationMs: Date.now() - start,
      },
      'inquiry-prefetch: Einzelabruf geschrieben',
    );
    return 'fetched';
  } catch (err) {
    logger.warn(
      { threadId, reservationId: id, err: err instanceof Error ? err.message : String(err) },
      'inquiry-prefetch: Einzelabruf fehlgeschlagen (non-fatal, Eingang läuft ohne Daten weiter)',
    );
    return 'failed';
  }
}
