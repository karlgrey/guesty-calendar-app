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
 * Hostex (#983): die Property-API liefert keine Beschreibungsfelder, wohl aber
 * `GET /v3/listings` (Kanal-Listing, `metadata.descriptions[]`). Verknüpfung über
 * `GET /v3/properties` → `channels[].listing_id` (Airbnb). Gleicher Cache/Dedupe/Fehler-Halte-
 * Schutz wie Guesty, eigener Cache-Schlüssel `hostex:<propertyId>`. Hausregeln und
 * Check-in-Anleitung liefert Hostex nicht.
 * airbnb-mail (Florenz): keine API → `texts: null` mit Hinweis.
 */

import { guestyClient } from './guesty-client.js';
import { getHostexClient } from './hostex-client.js';
import {
  mapListingTexts, mapHostexListingTexts, hasAnyListingText, type ListingTexts,
} from '../mappers/listing-texts-mapper.js';
import { getListingId, type PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export const LISTING_TEXTS_TTL_MS = 60 * 60 * 1000;
export const LISTING_TEXTS_ERROR_HOLD_MS = 60 * 1000;
export const LISTING_TEXTS_WAIT_MS = 3000;

export const NOTE_GUESTY_FAILED = 'Guesty-Abruf der Listing-Texte fehlgeschlagen — später erneut versuchen.';
export const NOTE_GUESTY_PENDING = 'Listing-Texte werden gerade aus Guesty geladen — später erneut versuchen.';
export const NOTE_HOSTEX_FAILED = 'Hostex-Abruf der Listing-Texte (GET /v3/properties + /v3/listings) fehlgeschlagen — später erneut versuchen.';
export const NOTE_HOSTEX_PENDING = 'Listing-Texte werden gerade aus Hostex geladen — später erneut versuchen.';
export const NOTE_HOSTEX_EMPTY = 'Hostex GET /v3/listings liefert für dieses Objekt keine gefüllten Textfelder (metadata.descriptions[], title, metadata.feature geprüft).';

/** Kein Airbnb-Kanal-Listing zur Hostex-Property gefunden. */
export class HostexListingNotFoundError extends Error {}

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

function fetchTexts(key: string, slug: string, load: () => Promise<ListingTexts>): Promise<ListingTexts> {
  const running = inflight.get(key);
  if (running) return running;
  const p = load()
    .then((texts) => {
      cache.set(key, { at: Date.now(), texts });
      lastError.delete(key);
      return texts;
    })
    .catch((err: unknown) => {
      lastError.set(key, Date.now());
      logger.warn({ err, slug }, 'Listing-Texte: Abruf fehlgeschlagen');
      throw err;
    })
    .finally(() => inflight.delete(key));
  // Ein Aufrufer kann nach der Wartegrenze schon weg sein → Rejection gilt als behandelt.
  p.catch(() => {});
  inflight.set(key, p);
  return p;
}

async function loadGuestyTexts(listingId: string): Promise<ListingTexts> {
  return mapListingTexts(await guestyClient.getListing(listingId));
}

/** Hostex: Property → Airbnb-Kanal-Listing-ID → Listing mit Beschreibungen (nur GET). */
async function loadHostexTexts(hostexPropertyId: string): Promise<ListingTexts> {
  const client = getHostexClient(); // wirft ohne Token → als Abruf-Fehler behandelt
  const properties = await client.getProperties();
  const prop = properties.find((p) => String(p.id) === hostexPropertyId);
  const channelIds = (prop?.channels ?? [])
    .filter((c) => c.channel_type === 'airbnb')
    .map((c) => c.listing_id);
  if (channelIds.length === 0) {
    throw new HostexListingNotFoundError(`Hostex-Property ${hostexPropertyId}: kein Airbnb-Kanal in GET /v3/properties`);
  }
  const listings = await client.getListings();
  const listing = listings.find((l) => l.channel_type === 'airbnb' && channelIds.includes(l.listing_id));
  if (!listing) {
    throw new HostexListingNotFoundError(`Hostex-Property ${hostexPropertyId}: Airbnb-Listing nicht in GET /v3/listings`);
  }
  return mapHostexListingTexts(listing);
}

function noteForError(err: unknown, provider: 'guesty' | 'hostex'): string {
  if (err instanceof HostexListingNotFoundError) return `${err.message} — keine Texte abrufbar.`;
  if (err instanceof WaitTimeout) return provider === 'hostex' ? NOTE_HOSTEX_PENDING : NOTE_GUESTY_PENDING;
  return provider === 'hostex' ? NOTE_HOSTEX_FAILED : NOTE_GUESTY_FAILED;
}

function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaitTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function getListingTextsForProperty(property: PropertyConfig): Promise<ListingTextsResult> {
  if (property.provider === 'airbnb-mail') {
    return {
      available: false, source: 'airbnb-mail', texts: null,
      note: 'Objekt läuft ohne API-Anbindung (airbnb-mail) — Texte nur im Airbnb-UI einsehbar.',
    };
  }

  let source: 'guesty' | 'hostex';
  let key: string;
  let load: () => Promise<ListingTexts>;
  if (property.provider === 'hostex') {
    const hostexPropertyId = property.hostexPropertyId;
    if (!hostexPropertyId) {
      return { available: false, source: 'hostex', texts: null, note: 'Hostex-Objekt ohne hostexPropertyId in properties.json.' };
    }
    source = 'hostex';
    key = `hostex:${hostexPropertyId}`;
    load = () => loadHostexTexts(hostexPropertyId);
  } else {
    const listingId = getListingId(property);
    source = 'guesty';
    key = listingId;
    load = () => loadGuestyTexts(listingId);
  }

  // Hostex: Listing gefunden, aber kein einziges Textfeld gefüllt → available:false + präziser Hinweis.
  const ok = (texts: ListingTexts): ListingTextsResult =>
    source === 'hostex' && !hasAnyListingText(texts)
      ? { available: false, source, texts: null, note: NOTE_HOSTEX_EMPTY }
      : { available: true, source, texts };

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LISTING_TEXTS_TTL_MS) return ok(hit.texts);
  const stale = hit ? ok(hit.texts) : null;

  const errAt = lastError.get(key);
  if (errAt !== undefined && Date.now() - errAt < LISTING_TEXTS_ERROR_HOLD_MS && !inflight.has(key)) {
    return stale ?? { available: false, source, texts: null, note: source === 'hostex' ? NOTE_HOSTEX_FAILED : NOTE_GUESTY_FAILED };
  }

  try {
    const texts = await waitAtMost(fetchTexts(key, property.slug, load), LISTING_TEXTS_WAIT_MS);
    return ok(texts);
  } catch (err) {
    if (stale) return stale;
    return { available: false, source, texts: null, note: noteForError(err, source) };
  }
}
