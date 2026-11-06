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
