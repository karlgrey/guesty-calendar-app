/**
 * Listing-Texte-Service (#1043)
 *
 * Liefert die öffentlichen Inserat-Texte (+ Gästeanleitungen) eines Objekts. Die Texte
 * liegen nicht in der lokalen DB, daher live aus Guesty (`GET /listings/{id}`), mit
 * In-Memory-Cache (1 h), damit der öffentliche Endpunkt `/p/:slug/listing` keinen
 * Guesty-Request pro Aufruf auslöst. Rein lesend.
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

export interface ListingTextsResult {
  available: boolean;
  source: PropertyConfig['provider'];
  texts: ListingTexts | null;
  note?: string;
}

const cache = new Map<string, { at: number; texts: ListingTexts }>();

export function clearListingTextsCache(): void {
  cache.clear();
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
  try {
    const listing = await guestyClient.getListing(listingId);
    const texts = mapListingTexts(listing);
    cache.set(listingId, { at: Date.now(), texts });
    return { available: true, source: 'guesty', texts };
  } catch (err) {
    logger.warn({ err, slug: property.slug }, 'Listing-Texte: Guesty-Abruf fehlgeschlagen');
    return { available: false, source: 'guesty', texts: null, note: 'Guesty-Abruf der Listing-Texte fehlgeschlagen — später erneut versuchen.' };
  }
}
