/**
 * Listing-Texte-Mapper (#1043)
 *
 * Mappt die öffentlichen Inserat-Texte aus der Guesty-Listing-Antwort
 * (`publicDescription`) plus die Gästeanleitungen (`checkInInstructions.notes`,
 * `checkOutInstructions`). Pure Funktion, nur lesend. Fehlende/leere Felder → null,
 * damit der Konsument "nicht gepflegt" von "leer" nicht unterscheiden muss.
 */

import type { GuestyListing } from '../types/guesty';
import type { HostexListing, HostexListingDescription } from '../types/hostex';

export const PUBLIC_DESCRIPTION_FIELDS = [
  'summary',
  'space',
  'access',
  'neighborhood',
  'transit',
  'notes',
  'interactionWithGuests',
  'houseRules',
] as const;

export type PublicDescriptionField = (typeof PUBLIC_DESCRIPTION_FIELDS)[number];
export type PublicDescription = Record<PublicDescriptionField, string | null>;

export interface GuestInstructions {
  checkInNotes: string | null;
  checkOutInstructions: string | null;
}

export interface ListingTexts {
  publicDescription: PublicDescription;
  guestInstructions: GuestInstructions;
  /**
   * #983: nur bei Hostex — Textfelder ohne Guesty-Entsprechung, flach mit Hostex-Rohpfad
   * als Schlüssel (z. B. `metadata.descriptions[0].about_amenity`). Fehlt bei Guesty.
   */
  hostexTexts?: Record<string, string | null>;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

export function emptyPublicDescription(): PublicDescription {
  return Object.fromEntries(PUBLIC_DESCRIPTION_FIELDS.map((f) => [f, null])) as PublicDescription;
}

export function mapListingTexts(
  listing: Pick<GuestyListing, 'publicDescription' | 'checkInInstructions' | 'checkOutInstructions'>
): ListingTexts {
  const publicDescription = emptyPublicDescription();
  for (const field of PUBLIC_DESCRIPTION_FIELDS) {
    publicDescription[field] = textOrNull(listing.publicDescription?.[field]);
  }
  return {
    publicDescription,
    guestInstructions: {
      checkInNotes: textOrNull(listing.checkInInstructions?.notes),
      checkOutInstructions: textOrNull(listing.checkOutInstructions),
    },
  };
}

// ── Hostex (#983) ────────────────────────────────────────────────────────────

/** Hostex-Beschreibungsfeld → Guesty-`publicDescription`-Feld (gleiche Bedeutung im Airbnb-Inserat). */
export const HOSTEX_DESCRIPTION_MAP = {
  description: 'summary',
  about_your_house: 'space',
  about_street: 'neighborhood',
  about_traffic: 'transit',
  about_others: 'notes',
  about_interaction: 'interactionWithGuests',
} as const satisfies Partial<Record<keyof HostexListingDescription, PublicDescriptionField>>;

/** Alle Textfelder eines Hostex-Beschreibungsblocks (für den flachen Rest-Block). */
const HOSTEX_DESCRIPTION_TEXT_FIELDS = [
  'locale', 'title', 'description', 'about_your_house', 'about_amenity',
  'about_interaction', 'about_others', 'about_street', 'about_traffic',
] as const satisfies ReadonlyArray<keyof HostexListingDescription>;

/**
 * Mappt ein Hostex-Kanal-Listing (GET /v3/listings). Die erste Beschreibung (Hauptsprache)
 * füllt `publicDescription`; Felder ohne Entsprechung und weitere Sprachen landen flach in
 * `hostexTexts`. Hausregeln, Zugang und Gästeanleitungen liefert Hostex nicht → null.
 */
export function mapHostexListingTexts(listing: Pick<HostexListing, 'title' | 'metadata'>): ListingTexts {
  const publicDescription = emptyPublicDescription();
  const hostexTexts: Record<string, string | null> = {
    title: textOrNull(listing.title),
    'metadata.feature': textOrNull(listing.metadata?.feature),
  };
  const descriptions = listing.metadata?.descriptions ?? [];
  descriptions.forEach((d, i) => {
    const prefix = `metadata.descriptions[${i}].`;
    for (const field of HOSTEX_DESCRIPTION_TEXT_FIELDS) {
      const mapped = (HOSTEX_DESCRIPTION_MAP as Partial<Record<string, PublicDescriptionField>>)[field];
      if (i === 0 && mapped) {
        publicDescription[mapped] = textOrNull(d?.[field]);
      } else {
        hostexTexts[prefix + field] = textOrNull(d?.[field]);
      }
    }
  });
  return {
    publicDescription,
    guestInstructions: { checkInNotes: null, checkOutInstructions: null },
    hostexTexts,
  };
}

/** true, wenn mindestens ein Inseratstext (außer Sprachkennung) gefüllt ist. */
export function hasAnyListingText(texts: ListingTexts): boolean {
  const values = [
    ...Object.values(texts.publicDescription),
    ...Object.values(texts.guestInstructions),
    ...Object.entries(texts.hostexTexts ?? {}).filter(([k]) => !k.endsWith('.locale')).map(([, v]) => v),
  ];
  return values.some((v) => v !== null);
}
