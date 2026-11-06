import { describe, it, expect } from 'vitest';
import { unifiedLineDiff } from './line-diff.js';

// #1062: kompakter Zeilen-Diff (unified, 1 Kontextzeile, ohne Datei-Header) für /auto-send/decisions.
describe('unifiedLineDiff', () => {
  it('identische Texte → leerer String', () => {
    expect(unifiedLineDiff('a\nb', 'a\nb')).toBe('');
  });

  it('eine geänderte Zeile mit je einer Kontextzeile', () => {
    const a = 'Hallo Anna,\ndanke für die Nachricht.\nCheck-in ab 15 Uhr.\nViele Grüße\nMicha';
    const b = 'Hallo Anna,\ndanke für die Nachricht.\nCheck-in ab 16 Uhr.\nViele Grüße\nMicha';
    expect(unifiedLineDiff(a, b)).toBe(
      '@@ -2,3 +2,3 @@\n danke für die Nachricht.\n-Check-in ab 15 Uhr.\n+Check-in ab 16 Uhr.\n Viele Grüße',
    );
  });

  it('eingefügte Zeile am Ende', () => {
    expect(unifiedLineDiff('a\nb', 'a\nb\nc')).toBe('@@ -2,1 +2,2 @@\n b\n+c');
  });

  it('gelöschte Zeile am Anfang', () => {
    expect(unifiedLineDiff('x\na\nb', 'a\nb')).toBe('@@ -1,2 +1,1 @@\n-x\n a');
  });

  it('weit auseinanderliegende Änderungen → zwei Hunks', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const b = ['1x', '2', '3', '4', '5', '6', '7', '8x'].join('\n');
    expect(unifiedLineDiff(a, b)).toBe('@@ -1,2 +1,2 @@\n-1\n+1x\n 2\n@@ -7,2 +7,2 @@\n 7\n-8\n+8x');
  });

  it('nahe Änderungen verschmelzen zu einem Hunk', () => {
    expect(unifiedLineDiff('a\nb\nc', 'A\nb\nC')).toBe('@@ -1,3 +1,3 @@\n-a\n+A\n b\n-c\n+C');
  });

  it('leerer Ausgangstext', () => {
    expect(unifiedLineDiff('', 'neu')).toBe('@@ -1,1 +1,1 @@\n-\n+neu');
  });

  it('normalisiert CRLF', () => {
    expect(unifiedLineDiff('a\r\nb', 'a\nb')).toBe('');
  });
});
