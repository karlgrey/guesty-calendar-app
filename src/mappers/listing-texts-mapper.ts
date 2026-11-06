/**
 * Listing-Texte-Mapper (#1043)
 *
 * Mappt die öffentlichen Inserat-Texte aus der Guesty-Listing-Antwort
 * (`publicDescription`) plus die Gästeanleitungen (`checkInInstructions.notes`,
 * `checkOutInstructions`). Pure Funktion, nur lesend. Fehlende/leere Felder → null,
 * damit der Konsument "nicht gepflegt" von "leer" nicht unterscheiden muss.
 */

import type { GuestyListing } from '../types/guesty';

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
