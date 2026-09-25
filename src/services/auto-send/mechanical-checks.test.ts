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
  it('schemelose Domain mit Pfad → url (#686 Nachzieh-Liste)', () => {
    expect(flags('Alles Weitere auf farmhouse-prasser.de/x')).toContain('url');
    expect(flags('Details unter beispiel.com/booking/123')).toContain('url');
  });
  it('normale Sätze mit Punkt lösen KEIN url-Flag aus', () => {
    expect(flags('Der Check-in ist z.B. ab 15 Uhr möglich.')).not.toContain('url');
    expect(flags('Das Haus ist ruhig gelegen, bzw. direkt am Wald.')).not.toContain('url');
    expect(flags('Die Fläche beträgt 12.50 Quadratmeter.')).not.toContain('url');
    expect(flags('Wir hatten letztes Jahr 1.200 Gäste.')).not.toContain('url');
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
  it('Substantiv „Bestätigung über Airbnb“ (Pflichthinweis) → keine Flags', () => {
    expect(flagsFor('Die endgültige Bestätigung der Buchung läuft über Airbnb.')).toEqual([]);
  });
  it('Verb „wir bestätigen dir das gleich“ → confirmation_words', () => {
    expect(flagsFor('Wir bestätigen dir das gleich final.')).toContain('confirmation_words');
  });
  it('reine Rückfrage ohne Bestätigungswort → keine Flags', () => {
    expect(flagsFor('Danke für die Anfrage! Magst du uns noch sagen, um welchen Anlass es geht und wie viele Personen inkl. Tagesgästen ihr seid?')).toEqual([]);
  });
  it('ohne isBookingRequest läuft der Check nicht (Rückwärtskompatibilität)', () => {
    expect(flags('Das ist bestätigt, freuen uns auf euch!')).not.toContain('confirmation_words');
  });
});

// #698 (Fall Lorenzo U19, 20.09.2026): Wochentags-Check — der Entwurfs-Systemprompt kannte
// bisher weder Wochentag noch Uhrzeit, ein sonntags gepostetes "have a wonderful Sunday" wurde
// deshalb erst montags mit gespiegeltem "schönen Sonntag" versandt.
describe('runMechanicalChecks — zeitbezug_veraltet (#698)', () => {
  const monday = new Date('2026-09-21T09:00:00.000Z'); // Montag, Europe/Berlin 11:00
  const flagsFor = (body: string, now: Date = monday, bookingContext: string | null = null) =>
    runMechanicalChecks(body, { knownDigitRuns: [], now, bookingContext }).map((f) => f.flag);

  it('(a) "Schönen Sonntag noch!" bei now=Montag → zeitbezug_veraltet', () => {
    expect(flagsFor('Schönen Sonntag noch!')).toContain('zeitbezug_veraltet');
  });
  it('(b) "Schönen Montag!" bei now=Montag → keine Flags', () => {
    expect(flagsFor('Schönen Montag!')).toEqual([]);
  });
  it('(b2) „Montage“ ist kein Wochentag (Review 25.09.): bei now=Sonntag kein Flag, „Montagabend“ aber schon', () => {
    const sunday = new Date('2026-09-20T09:00:00.000Z');
    const at = (b: string) => runMechanicalChecks(b, { knownDigitRuns: [], now: sunday }).map((f) => f.flag);
    expect(at('Die Montage der Küche ist fertig.')).toEqual([]);
    expect(at('Bis Montagabend!')).toContain('zeitbezug_veraltet');
  });
  it('(c) EN "Enjoy your Sunday" bei now=Montag → zeitbezug_veraltet', () => {
    expect(flagsFor('Enjoy your Sunday!')).toContain('zeitbezug_veraltet');
  });
  it('(d) Anreise Freitag laut bookingContext, Entwurf "bis Freitag!" bei now=Montag → keine Flags', () => {
    const bookingContext = 'Buchung: Zeitraum 25.09.2026–27.09.2026, 2 Nächte, 2 Personen, Konfirmationscode X.';
    expect(flagsFor('Wir freuen uns, bis Freitag!', monday, bookingContext)).toEqual([]);
  });
  it('(e) Aufenthalt Fr–So, "am Samstag" → keine Flags', () => {
    const bookingContext = 'Buchung: Zeitraum 25.09.2026–27.09.2026, 2 Nächte, 2 Personen, Konfirmationscode X.';
    expect(flagsFor('Am Samstag ist auch der Markt geöffnet.', monday, bookingContext)).toEqual([]);
  });
  it('(f) ohne now läuft der Check nicht (Rückwärtskompatibilität)', () => {
    expect(flags('Schönen Sonntag noch!')).not.toContain('zeitbezug_veraltet');
  });
  it('(g) Fall Lorenzo: neutrale Formulierung ohne Wochentag → keine Flags', () => {
    expect(flagsFor('Danke dir! Euch eine gute Zeit.')).toEqual([]);
  });
  it('Komposita wie „Sonntagabend" matchen ebenfalls (kein trailing Wortgrenze)', () => {
    expect(flagsFor('Wir wünschen einen schönen Sonntagabend.')).toContain('zeitbezug_veraltet');
  });
  it('liefert Fundstelle', () => {
    const f = runMechanicalChecks('Schönen Sonntag noch!', { knownDigitRuns: [], now: monday, bookingContext: null });
    expect(f).toEqual([{ flag: 'zeitbezug_veraltet', match: 'Sonntag' }]);
  });
});
