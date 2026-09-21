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
    expect(flags('Zahl per EUR120 bitte')).toContain('money');
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
  it('Code-Wort mit ausgeschriebenem Zahlwort im selben Satz → code_words', () => {
    expect(flags('Der Code ist eins zwei drei vier.')).toContain('code_words');
    expect(flags('Der Tresor steht neben der Tür.')).not.toContain('code_words');
    expect(flags('The PIN is four two.')).toContain('code_words');
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

// #695: mechanischer Sprach-Check — unabhängig vom Prüfmodell (Spec 2).
describe('runMechanicalChecks — language_mismatch', () => {
  const flagsFor = (body: string, guestLanguage: 'de' | 'en' | 'it' | 'es' | 'fr') =>
    runMechanicalChecks(body, { knownDigitRuns: [], guestLanguage }).map((f) => f.flag);

  it('Entwurf auf Deutsch, Gast schrieb Englisch → language_mismatch', () => {
    expect(flagsFor('Hallo Lorenzo, vielen Dank für deine Nachricht!', 'en')).toContain('language_mismatch');
  });
  it('Entwurf auf Englisch, Gast schrieb Englisch → keine Flags', () => {
    expect(flagsFor('Hi Lorenzo, thanks so much for your message!', 'en')).toEqual([]);
  });
  it('Entwurf auf Deutsch, Gast schrieb Deutsch → keine Flags', () => {
    expect(flagsFor('Hallo Anna, vielen Dank für deine Nachricht!', 'de')).toEqual([]);
  });
  it('ohne guestLanguage im Kontext läuft kein Sprach-Check (Rückwärtskompatibilität)', () => {
    expect(flags('Hallo Lorenzo, vielen Dank für deine Nachricht!')).toEqual([]);
  });
});

// #697: Bestätigungswort-Check — nur relevant im Buchungsanfrage-Kontext (eine Rückfrage darf
// nie wie eine Zusage/Bestätigung klingen).
describe('runMechanicalChecks — confirmation_words (#697, nur Buchungsanfrage-Kontext)', () => {
  const flagsFor = (body: string) => runMechanicalChecks(body, { knownDigitRuns: [], isBookingRequest: true }).map((f) => f.flag);

  it('"bestätigt" → confirmation_words', () => expect(flagsFor('Das ist bestätigt, freuen uns auf euch!')).toContain('confirmation_words'));
  it('"steht ... nichts im Weg" → confirmation_words', () => {
    expect(flagsFor('Von uns aus steht einer Bestätigung nichts im Weg.')).toContain('confirmation_words');
  });
  it('englisch "confirmed"/"accepted" → confirmation_words', () => {
    expect(flagsFor('Your request has been confirmed.')).toContain('confirmation_words');
    expect(flagsFor('Your request has been accepted.')).toContain('confirmation_words');
  });
  it('reine Rückfrage ohne Bestätigungswort → keine Flags', () => {
    expect(flagsFor('Danke für die Anfrage! Magst du uns noch sagen, um welchen Anlass es geht und wie viele Personen inkl. Tagesgästen ihr seid?')).toEqual([]);
  });
  it('ohne isBookingRequest läuft der Check nicht (Rückwärtskompatibilität)', () => {
    expect(flags('Das ist bestätigt, freuen uns auf euch!')).not.toContain('confirmation_words');
  });
});
