import { describe, it, expect } from 'vitest';
import { isAutomaticHostMessage, AUTO_HOST_MESSAGE_PATTERNS } from './auto-message.js';

const checkin = (name: string, datum: string, nl = '\n') =>
  `Hallo ${name}, dein Aufenthalt findet bald statt. Du kannst am ${datum} jederzeit einchecken.${nl}${nl}` +
  `Hier ist die Adresse: Musterstraße 1, 12345 Musterstadt. Hier sind die WLAN-Zugangsdaten: Name: Test, Passwort: xxx.${nl}${nl}` +
  `Wenn du Fragen hast, gib mir gern Bescheid. Ich wünsche dir einen schönen Aufenthalt.`;

describe('isAutomaticHostMessage', () => {
  it('erkennt die Check-in-Vorlage', () => {
    expect(isAutomaticHostMessage(checkin('Anna', '20. Nov. 2026 ab 15:00'))).toBe(true);
  });
  it('erkennt sie mit CRLF', () => {
    expect(isAutomaticHostMessage(checkin('Anna', '20. Nov. 2026 ab 15:00', '\r\n'))).toBe(true);
  });
  it('erkennt sie mit anderem Namen und Datum', () => {
    expect(isAutomaticHostMessage(checkin('Bernd', '3. Dez. 2026 ab 16:00'))).toBe(true);
  });
  it('ist unabhängig von Groß-/Kleinschreibung', () => {
    expect(isAutomaticHostMessage(checkin('Anna', '20. Nov. 2026 ab 15:00').toUpperCase())).toBe(true);
    expect(isAutomaticHostMessage(checkin('Anna', '20. Nov. 2026 ab 15:00').toLowerCase())).toBe(true);
  });
  it('wiederholte Aufrufe liefern stabil dasselbe Ergebnis (kein lastIndex)', () => {
    const t = checkin('Anna', '20. Nov. 2026 ab 15:00');
    expect(isAutomaticHostMessage(t)).toBe(true);
    expect(isAutomaticHostMessage(t)).toBe(true);
  });
  it('erkennt normale Host-Antworten nicht', () => {
    expect(isAutomaticHostMessage('Hey Anna, früher einchecken ab 14:00 Uhr ist in der Regel kein Problem.')).toBe(false);
    expect(isAutomaticHostMessage('Hallo Bernd, danke für die Info. Eine späte Ankunft gegen 21 Uhr ist kein Problem, der Schlüssel liegt bereit.')).toBe(false);
  });
  it('leer/fehlend → false', () => {
    expect(isAutomaticHostMessage('')).toBe(false);
    expect(isAutomaticHostMessage(undefined)).toBe(false);
    expect(isAutomaticHostMessage(null)).toBe(false);
  });
  it('eigenes Muster greift, Default dann nicht', () => {
    expect(isAutomaticHostMessage('Testvorlage Willkommen', [/Testvorlage/i])).toBe(true);
    expect(isAutomaticHostMessage(checkin('Anna', '20. Nov. 2026 ab 15:00'), [/Testvorlage/i])).toBe(false);
  });
  it('Default-Liste hat genau einen Eintrag ohne g-Flag', () => {
    expect(AUTO_HOST_MESSAGE_PATTERNS).toHaveLength(1);
    expect(AUTO_HOST_MESSAGE_PATTERNS[0].global).toBe(false);
  });
});
