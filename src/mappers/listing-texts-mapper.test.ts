import { describe, it, expect } from 'vitest';
import { mapListingTexts, emptyPublicDescription } from './listing-texts-mapper';

describe('mapListingTexts (#1043)', () => {
  it('mappt alle öffentlichen Textfelder und die Gästeanleitungen', () => {
    const r = mapListingTexts({
      publicDescription: {
        summary: 'S', space: 'Sp', access: 'A', neighborhood: 'N', transit: 'T',
        notes: 'No', interactionWithGuests: 'I', houseRules: 'H',
      },
      checkInInstructions: { primaryCheckIn: 'LOCK_BOX', notes: 'Schlüsselbox links' },
      checkOutInstructions: 'Fenster schließen',
    });
    expect(r.publicDescription).toEqual({
      summary: 'S', space: 'Sp', access: 'A', neighborhood: 'N', transit: 'T',
      notes: 'No', interactionWithGuests: 'I', houseRules: 'H',
    });
    expect(r.guestInstructions).toEqual({ checkInNotes: 'Schlüsselbox links', checkOutInstructions: 'Fenster schließen' });
  });

  it('fehlende, leere und Whitespace-Felder werden null', () => {
    const r = mapListingTexts({
      publicDescription: { summary: 'Nur Summary', space: '   ', access: '' },
      checkInInstructions: { primaryCheckIn: 'LOCK_BOX', notes: '' },
    });
    expect(r.publicDescription.summary).toBe('Nur Summary');
    expect(r.publicDescription.space).toBeNull();
    expect(r.publicDescription.access).toBeNull();
    expect(r.publicDescription.houseRules).toBeNull();
    expect(r.guestInstructions).toEqual({ checkInNotes: null, checkOutInstructions: null });
  });

  it('ohne publicDescription/Anleitungen: alles null, kein Fehler', () => {
    const r = mapListingTexts({});
    expect(r.publicDescription).toEqual(emptyPublicDescription());
    expect(Object.values(r.publicDescription).every((v) => v === null)).toBe(true);
  });

  it('Texte bleiben unverändert (kein Trim/Umbau)', () => {
    const text = 'Zeile 1\n\nZeile 2 ';
    expect(mapListingTexts({ publicDescription: { space: text } }).publicDescription.space).toBe(text);
  });
});

import { mapHostexListingTexts, hasAnyListingText } from './listing-texts-mapper';
import hostexListingsFixture from '../test-fixtures/hostex/listings.json';

describe('mapHostexListingTexts (#983)', () => {
  it('mappt Hostex-Beschreibung auf publicDescription, Rest flach in hostexTexts', () => {
    const r = mapHostexListingTexts({
      title: 'Listing-Titel',
      metadata: {
        feature: 'Feature-Text',
        descriptions: [{
          locale: 'de', title: 'Beschr.-Titel', description: 'D', about_your_house: 'H',
          about_amenity: 'Am', about_interaction: 'I', about_others: 'O', about_street: 'St', about_traffic: 'Tr',
        }],
      },
    });
    expect(r.publicDescription).toEqual({
      summary: 'D', space: 'H', access: null, neighborhood: 'St', transit: 'Tr',
      notes: 'O', interactionWithGuests: 'I', houseRules: null,
    });
    expect(r.guestInstructions).toEqual({ checkInNotes: null, checkOutInstructions: null });
    expect(r.hostexTexts).toEqual({
      title: 'Listing-Titel',
      'metadata.feature': 'Feature-Text',
      'metadata.descriptions[0].locale': 'de',
      'metadata.descriptions[0].title': 'Beschr.-Titel',
      'metadata.descriptions[0].about_amenity': 'Am',
    });
  });

  it('weitere Sprachen landen vollständig in hostexTexts (für den Telefonnummern-Scan)', () => {
    const r = mapHostexListingTexts({
      title: 'T',
      metadata: { descriptions: [{ locale: 'de', description: 'DE' }, { locale: 'en', description: 'EN', about_your_house: 'House' }] },
    });
    expect(r.publicDescription.summary).toBe('DE');
    expect(r.hostexTexts?.['metadata.descriptions[1].locale']).toBe('en');
    expect(r.hostexTexts?.['metadata.descriptions[1].description']).toBe('EN');
    expect(r.hostexTexts?.['metadata.descriptions[1].about_your_house']).toBe('House');
  });

  it('leere/fehlende Felder → null; ohne Beschreibungen nur title/feature', () => {
    const r = mapHostexListingTexts({ title: '  ', metadata: null });
    expect(r.hostexTexts).toEqual({ title: null, 'metadata.feature': null });
    expect(Object.values(r.publicDescription).every((v) => v === null)).toBe(true);
    expect(hasAnyListingText(r)).toBe(false);
  });

  it('Fixture: Texte gefüllt, hasAnyListingText true', () => {
    const r = mapHostexListingTexts(hostexListingsFixture.data.listings[0]);
    expect(r.publicDescription.summary).toBeTruthy();
    expect(r.publicDescription.space).toBeTruthy();
    expect(hasAnyListingText(r)).toBe(true);
  });

  it('hasAnyListingText ignoriert die reine Sprachkennung', () => {
    const r = mapHostexListingTexts({ title: null, metadata: { descriptions: [{ locale: 'de' }] } });
    expect(hasAnyListingText(r)).toBe(false);
  });

  it('Guesty-Mapping bleibt ohne hostexTexts', () => {
    expect(mapListingTexts({ publicDescription: { summary: 'S' } })).not.toHaveProperty('hostexTexts');
  });
});
