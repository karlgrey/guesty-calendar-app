import { describe, it, expect } from 'vitest';
import { countSentences, checkDraftExpectation, stripGreetingAndClosing } from './draft-fixture-check.js';
import type { DraftResult } from './draft-service.js';

const text = (body: string): DraftResult => ({ kind: 'text', body });

describe('countSentences', () => {
  it('zählt einfache Sätze', () => {
    expect(countSentences('Das passt. Wir freuen uns! Alles gut?')).toBe(3);
  });
  it('zählt Anrede und Gruß (Zeilen) nicht', () => {
    expect(countSentences('Hallo Lea,\n\nKein Problem. Ich nehme die Änderung an.\n\nLiebe Grüße\nMicha')).toBe(2);
  });
  it('Gruß mit Komma und LG', () => {
    expect(countSentences('Hi Tom,\nJa, es gibt Platz.\nViele Grüße, Micha')).toBe(1);
    expect(countSentences('Hallo Tom,\nJa, klar.\nLG Micha')).toBe(1);
  });
  it('Abkürzungen sind kein Satzende', () => {
    expect(countSentences('Es gibt z. B. zwei Plätze, ca. 5 Min. entfernt, bzw. direkt vorm Haus.')).toBe(1);
    expect(countSentences('Siehe Nr. 5 im Plan. Danke.')).toBe(2);
  });
  it('Datumsangaben und Zahlen sind kein Satzende', () => {
    expect(countSentences('Ihr kommt am 20.11. an und reist am 21.11. ab. Passt das?')).toBe(2);
    expect(countSentences('Der Preis ist 12.50 Euro. Okay.')).toBe(2);
    expect(countSentences('Am 20. November seid ihr da.')).toBe(1);
  });
  it('Ellipse und mehrfache Satzzeichen zählen einmal', () => {
    expect(countSentences('Mal sehen… Ja!! Klar?!')).toBe(3);
  });
  it('Text ohne Schlusspunkt zählt', () => {
    expect(countSentences('Ja gerne')).toBe(1);
    expect(countSentences('')).toBe(0);
  });
  it('strip entfernt nur Rand', () => {
    expect(stripGreetingAndClosing('Hallo Lea,\nText hier.\nLiebe Grüße\nMicha')).toBe('Text hier.');
  });
});

describe('checkDraftExpectation', () => {
  it('noReply pass/fail', () => {
    expect(checkDraftExpectation({ kind: 'no_reply', reason: 'x' }, { noReply: true }).pass).toBe(true);
    const r = checkDraftExpectation(text('Danke!'), { noReply: true });
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/no_reply/);
  });
  it('ohne noReply muss kind text sein', () => {
    expect(checkDraftExpectation({ kind: 'no_reply', reason: 'x' }, {}).pass).toBe(false);
    expect(checkDraftExpectation({ kind: 'failed', error: 'x' }, {}).pass).toBe(false);
    expect(checkDraftExpectation(text('Hallo'), {}).pass).toBe(true);
  });
  it('maxSentences', () => {
    expect(checkDraftExpectation(text('Eins. Zwei.'), { maxSentences: 2 }).pass).toBe(true);
    expect(checkDraftExpectation(text('Eins. Zwei. Drei.'), { maxSentences: 2 }).pass).toBe(false);
  });
  it('maxChars ohne Anrede/Gruß', () => {
    const body = 'Hallo Lea,\nKurz und gut.\nLiebe Grüße\nMicha';
    expect(checkDraftExpectation(text(body), { maxChars: 15 }).pass).toBe(true);
    const r = checkDraftExpectation(text(body), { maxChars: 10 });
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/maxChars/);
  });
  it('mustContainAny case-insensitive', () => {
    expect(checkDraftExpectation(text('Kein PROBLEM!'), { mustContainAny: ['änderung', 'kein problem'] }).pass).toBe(true);
    expect(checkDraftExpectation(text('Hallo!'), { mustContainAny: ['änderung'] }).pass).toBe(false);
  });
  it('mustNotContain case-insensitive', () => {
    expect(checkDraftExpectation(text('Alles gut.'), { mustNotContain: ['bettwäsche'] }).pass).toBe(true);
    const r = checkDraftExpectation(text('Bettwäsche liegt bereit.'), { mustNotContain: ['bettwäsche'] });
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/bettwäsche/);
  });
});
