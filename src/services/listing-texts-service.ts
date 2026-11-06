/**
 * Listing-Texte-Service (#1043)
 *
 * Liefert die öffentlichen Inserat-Texte (+ Gästeanleitungen) eines Objekts. Die Texte
 * liegen nicht in der lokalen DB, daher live aus Guesty (`GET /listings/{id}`), mit
 * In-Memory-Cache (1 h), damit der öffentliche Endpunkt `/p/:slug/listing` keinen
 * Guesty-Request pro Aufruf auslöst. Rein lesend.
 *
 * Schutz der öffentlichen Route (Widget) — Review-Gate #1043:
 * - In-flight-Dedupe: parallele Aufrufe (Cold-Start-Sturm) teilen sich EINEN Guesty-Request.
 * - Wartegrenze: ein Aufruf wartet höchstens LISTING_TEXTS_WAIT_MS auf Guesty; danach
 *   antwortet er mit `texts: null` + Hinweis, der Abruf läuft im Hintergrund weiter und
 *   füllt den Cache (der Guesty-Client hat keinen Fetch-Timeout und retried mit Backoff).
 * - Fehler-Halte: nach einem Fehlschlag LISTING_TEXTS_ERROR_HOLD_MS lang kein neuer Abruf,
 *   sonst löst bei Guesty-Ausfall jeder Widget-Aufruf eine Retry-Kette aus.
 * - Stale-Fallback: abgelaufener Cache wird bei Fehler/Timeout weiter ausgeliefert.
 *
 * Hostex: die Property-API liefert keine Beschreibungsfelder (Fixture + Client geprüft,
 * nur Titel/Channels/Zeiten/WLAN/Adresse) → `texts: null` mit Hinweis.
 * airbnb-mail (Florenz): keine API → `texts: null` mit Hinweis.
 */

import { guestyClient } from './guesty-client.js';
import { mapListingTexts, type ListingTexts } from '../mappers/listing-texts-mapper.js';
import { getListingId, type PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export const LISTING_TEXTS_TTL_MS = 60 * 60 * 1000;
export const LISTING_TEXTS_ERROR_HOLD_MS = 60 * 1000;
export const LISTING_TEXTS_WAIT_MS = 3000;

export const NOTE_GUESTY_FAILED = 'Guesty-Abruf der Listing-Texte fehlgeschlagen — später erneut versuchen.';
export const NOTE_GUESTY_PENDING = 'Listing-Texte werden gerade aus Guesty geladen — später erneut versuchen.';

export interface ListingTextsResult {
  available: boolean;
  source: PropertyConfig['provider'];
  texts: ListingTexts | null;
  note?: string;
}

const cache = new Map<string, { at: number; texts: ListingTexts }>();
const inflight = new Map<string, Promise<ListingTexts>>();
const lastError = new Map<string, number>();

export function clearListingTextsCache(): void {
  cache.clear();
  inflight.clear();
  lastError.clear();
}

class WaitTimeout extends Error {}

function fetchTexts(listingId: string, slug: string): Promise<ListingTexts> {
  const running = inflight.get(listingId);
  if (running) return running;
  const p = guestyClient.getListing(listingId)
    .then((listing) => {
      const texts = mapListingTexts(listing);
      cache.set(listingId, { at: Date.now(), texts });
      lastError.delete(listingId);
      return texts;
    })
    .catch((err: unknown) => {
      lastError.set(listingId, Date.now());
      logger.warn({ err, slug }, 'Listing-Texte: Guesty-Abruf fehlgeschlagen');
      throw err;
    })
    .finally(() => inflight.delete(listingId));
  // Ein Aufrufer kann nach der Wartegrenze schon weg sein → Rejection gilt als behandelt.
  p.catch(() => {});
  inflight.set(listingId, p);
  return p;
}

function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaitTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function getListingTextsForProperty(property: PropertyConfig): Promise<ListingTextsResult> {
  if (property.provider === 'hostex') {
    return {
      available: false, source: 'hostex', texts: null,
      note: 'Hostex-Property-API liefert keine Beschreibungsfelder (Titel, Channels, Zeiten, WLAN, Adresse) — Texte nur im Airbnb-UI einsehbar.',
    };
  }
  if (property.provider === 'airbnb-mail') {
    return {
      available: false, source: 'airbnb-mail', texts: null,
      note: 'Objekt läuft ohne API-Anbindung (airbnb-mail) — Texte nur im Airbnb-UI einsehbar.',
    };
  }

  const listingId = getListingId(property);
  const hit = cache.get(listingId);
  if (hit && Date.now() - hit.at < LISTING_TEXTS_TTL_MS) {
    return { available: true, source: 'guesty', texts: hit.texts };
  }
  const stale = hit ? { available: true, source: 'guesty' as const, texts: hit.texts } : null;

  const errAt = lastError.get(listingId);
  if (errAt !== undefined && Date.now() - errAt < LISTING_TEXTS_ERROR_HOLD_MS && !inflight.has(listingId)) {
    return stale ?? { available: false, source: 'guesty', texts: null, note: NOTE_GUESTY_FAILED };
  }

  try {
    const texts = await waitAtMost(fetchTexts(listingId, property.slug), LISTING_TEXTS_WAIT_MS);
    return { available: true, source: 'guesty', texts };
  } catch (err) {
    if (stale) return stale;
    const note = err instanceof WaitTimeout ? NOTE_GUESTY_PENDING : NOTE_GUESTY_FAILED;
    return { available: false, source: 'guesty', texts: null, note };
  }
}
