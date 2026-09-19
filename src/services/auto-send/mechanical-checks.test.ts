import { describe, it, expect } from 'vitest';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';

const flags = (body: string, known: string[] = []) => runMechanicalChecks(body, { knownDigitRuns: known }).map((f) => f.flag);

describe('runMechanicalChecks', () => {
  it('leer → empty', () => expect(flags('   ')).toEqual(['empty']));
  it('sauberer Text → keine Flags', () => expect(flags('Hallo Anna, 13 Uhr passt. Bis dann!')).toEqual([]));
  it('Ziffernfolge ≥ 4 ohne Kontext → digits', () => expect(flags('Der Code ist 4711.')).toContain('digits'));
  it('Ziffernfolge aus dem Kontext (Datum/Jahr) ist erlaubt', () => {
    expect(flags('Wir freuen uns auf 2026.', ['2026'])).not.toContain('digits');
    expect(flags('Bis zum 19.09.2026!', ['2026'])).not.toContain('digits');
  });
  it('URL → url', () => {
    expect(flags('Siehe https://farmhouse-prasser.de')).toContain('url');
    expect(flags('Siehe www.beispiel.de')).toContain('url');
  });
  it('E-Mail → email', () => expect(flags('Schreib an mic@beispiel.de')).toContain('email'));
  it('Geldbetrag → money', () => {
    expect(flags('Das kostet 120 €.')).toContain('money');
    expect(flags('Preis 120,00 pro Nacht')).toContain('money');
    expect(flags('Das sind 30 EUR extra')).toContain('money');
  });
  it('Telefonnummer → phone', () => {
    expect(flags('Ruf an: +49 160 1234567')).toContain('phone');
    expect(flags('Tel 0160/123 45 67')).toContain('phone');
  });
  it('Code-Wort mit Ziffer im selben Satz → code_words', () => {
    expect(flags('Der Tresor öffnet mit 12 34.')).toContain('code_words');
    expect(flags('Die PIN lautet 9.')).toContain('code_words');
    expect(flags('Der Schlüssel liegt im Tresor.')).not.toContain('code_words');
  });
  it('zu lang → length', () => expect(flags('a'.repeat(1201))).toContain('length'));
  it('liefert Fundstelle', () => {
    const f = runMechanicalChecks('Mail an x@y.de', { knownDigitRuns: [] });
    expect(f).toEqual([{ flag: 'email', match: 'x@y.de' }]);
  });
});

describe('collectDigitRuns', () => {
  it('sammelt Ziffernfolgen ≥ 4 aus Texten', () => {
    expect(collectDigitRuns(['Check-in 19.09.2026', 'Code HM12345678'])).toEqual(['2026', '12345678']);
  });
});
