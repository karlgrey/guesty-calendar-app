import { describe, it, expect } from 'vitest';
import { detectLanguage, SUPPORTED_LANGUAGES, LANGUAGE_LABEL } from './language-detect.js';

describe('detectLanguage', () => {
  it('erkennt Deutsch (Kurz-Dank)', () => {
    expect(detectLanguage('Danke, alles super!')).toBe('de');
  });
  it('erkennt Englisch (Kurz-Dank)', () => {
    expect(detectLanguage('Thanks so much, all good! 🙏')).toBe('en');
  });
  it('erkennt Italienisch (Kurz-Dank)', () => {
    expect(detectLanguage('Grazie mille, tutto perfetto!')).toBe('it');
  });
  it('erkennt Spanisch (Kurz-Dank)', () => {
    expect(detectLanguage('Muchas gracias, todo genial!')).toBe('es');
  });
  it('erkennt Französisch (Kurz-Dank)', () => {
    expect(detectLanguage('Merci beaucoup, tout est parfait!')).toBe('fr');
  });

  it('erkennt Englisch auch bei einem einzelnen Wort', () => {
    expect(detectLanguage('Thanks!')).toBe('en');
  });
  it('erkennt Deutsch auch bei einem einzelnen Wort', () => {
    expect(detectLanguage('Danke!')).toBe('de');
  });

  it('Emoji allein kippt nicht auf eine falsche Sprache — Fallback Deutsch', () => {
    expect(detectLanguage('👍👍👍')).toBe('de');
  });
  it('Emoji neben englischem Text kippt die Erkennung nicht', () => {
    expect(detectLanguage('Perfect, see you soon! 🎉🙌')).toBe('en');
  });

  it('Namen/Ortsnamen kippen die Erkennung nicht (EN mit Name+Stadt)', () => {
    expect(detectLanguage('Hi Marco, thanks a lot, see you in Florence!')).toBe('en');
  });
  it('Namen/Ortsnamen kippen die Erkennung nicht (DE mit Name)', () => {
    expect(detectLanguage('Hallo Lorenzo, vielen Dank für die Nachricht!')).toBe('de');
  });

  it('leerer/zu kurzer Text → Fallback Deutsch', () => {
    expect(detectLanguage('')).toBe('de');
    expect(detectLanguage('   ')).toBe('de');
    expect(detectLanguage('👍')).toBe('de');
  });

  it('reiner Eigenname ohne erkennbares Funktionswort → Fallback Deutsch', () => {
    expect(detectLanguage('Lorenzo')).toBe('de');
  });

  it('Mischtext mit klarem Übergewicht einer Sprache gewinnt (EN)', () => {
    expect(detectLanguage('Danke, that was so much appreciated, thank you very much!')).toBe('en');
  });

  it('deutsche Sonderzeichen (ß/ü/ä/ö) stützen die Erkennung bei knappem Text', () => {
    expect(detectLanguage('Für Sie eingerichtet, herzlichen Dank!')).toBe('de');
  });

  it('SUPPORTED_LANGUAGES und LANGUAGE_LABEL decken DE/EN/IT/ES/FR ab', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['de', 'en', 'it', 'es', 'fr']);
    expect(LANGUAGE_LABEL.de).toBe('Deutsch');
    expect(LANGUAGE_LABEL.en).toBe('Englisch');
    expect(LANGUAGE_LABEL.it).toBe('Italienisch');
    expect(LANGUAGE_LABEL.es).toBe('Spanisch');
    expect(LANGUAGE_LABEL.fr).toBe('Französisch');
  });
});
