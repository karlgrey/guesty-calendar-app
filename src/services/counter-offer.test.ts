// #1243: reine Funktionen für Gegenangebot / Nachlass-Bedingung (kein I/O).
import { describe, it, expect } from 'vitest';
import {
  computeStayFacts, formatStayFactsSentence, detectCounterOfferAmount,
  evaluateCounterOffer, formatCounterOfferNote, evaluateDiscountCondition, formatDiscountConditionSentence, type StayFacts,
} from './counter-offer.js';

// Fall Daniel: Anfrage 17.11.2026 (Di), Fr 20.11. – So 22.11.2026
const DANIEL = computeStayFacts('2026-11-20', '2026-11-22', '2026-11-17T10:00:00.000Z');

describe('computeStayFacts', () => {
  it('Fall Daniel: Nächte Fr+Sa, Wochenende, 3 Tage vorher', () => {
    expect(DANIEL).toEqual({
      requestedAt: '2026-11-17T10:00:00.000Z', requestDaysBeforeArrival: 3,
      nightWeekdays: [5, 6], weekendNight: true,
    });
  });
  it('Mo–Do ohne Wochenendnacht (Nacht Do→Fr zählt nicht, Fr-Nacht schon)', () => {
    const f = computeStayFacts('2026-11-23', '2026-11-26', null); // Mo..Mi Nächte
    expect(f.nightWeekdays).toEqual([1, 2, 3]);
    expect(f.weekendNight).toBe(false);
    expect(f.requestDaysBeforeArrival).toBeNull();
    expect(computeStayFacts('2026-11-26', '2026-11-28', null).weekendNight).toBe(true); // Do, Fr
  });
  it('nimmt den Berliner Kalendertag (23:30 UTC → schon nächster Tag)', () => {
    expect(computeStayFacts('2026-11-20', '2026-11-22', '2026-11-16T23:30:00Z').requestDaysBeforeArrival).toBe(3);
  });
  it('negativer Abstand oder ungültiges Datum → null', () => {
    expect(computeStayFacts('2026-11-20', '2026-11-22', '2026-11-25T10:00:00Z').requestDaysBeforeArrival).toBeNull();
    expect(computeStayFacts('2026-11-20', '2026-11-22', 'kaputt').requestDaysBeforeArrival).toBeNull();
  });
  it('ungültig oder checkOut ≤ checkIn → keine Nächte', () => {
    for (const [a, b] of [['', ''], ['2026-11-22', '2026-11-20'], ['2026-11-20', '2026-11-20'], ['x', 'y']]) {
      const f = computeStayFacts(a, b, null);
      expect(f.nightWeekdays).toEqual([]);
      expect(f.weekendNight).toBe(false);
    }
  });
  it('höchstens 7 Nächte', () => {
    expect(computeStayFacts('2026-11-16', '2026-11-30', null).nightWeekdays).toHaveLength(7);
  });
});

describe('formatStayFactsSentence', () => {
  it('Fall Daniel', () => {
    expect(formatStayFactsSentence(DANIEL)).toBe(
      'Anfrage gestellt am 17.11.2026, 3 Tage vor Anreise. Übernachtungen in den Nächten ab Freitag, Samstag (Wochenendnacht Fr/Sa dabei: ja).',
    );
  });
  it('1 Tag / am Anreisetag / ohne requestedAt', () => {
    const base: StayFacts = { requestedAt: '2026-11-19T10:00:00Z', requestDaysBeforeArrival: 1, nightWeekdays: [1], weekendNight: false };
    expect(formatStayFactsSentence(base)).toBe(
      'Anfrage gestellt am 19.11.2026, 1 Tag vor Anreise. Übernachtungen in den Nächten ab Montag (Wochenendnacht Fr/Sa dabei: nein).',
    );
    expect(formatStayFactsSentence({ ...base, requestDaysBeforeArrival: 0 })).toContain('am Anreisetag.');
    expect(formatStayFactsSentence({ ...base, requestedAt: null, requestDaysBeforeArrival: null })).toBe(
      'Übernachtungen in den Nächten ab Montag (Wochenendnacht Fr/Sa dabei: nein).',
    );
  });
  it('7 Nächte → alle Wochentage; keine Nächte → nur Anfrage-Satz bzw. leer', () => {
    const all: StayFacts = { requestedAt: null, requestDaysBeforeArrival: null, nightWeekdays: [1, 2, 3, 4, 5, 6, 0], weekendNight: true };
    expect(formatStayFactsSentence(all)).toBe('Übernachtungen an allen Wochentagen (Wochenendnacht Fr/Sa dabei: ja).');
    const none: StayFacts = { requestedAt: '2026-11-17T10:00:00Z', requestDaysBeforeArrival: 3, nightWeekdays: [], weekendNight: false };
    expect(formatStayFactsSentence(none)).toBe('Anfrage gestellt am 17.11.2026, 3 Tage vor Anreise.');
    expect(formatStayFactsSentence({ ...none, requestedAt: null })).toBe('');
  });
});

describe('detectCounterOfferAmount', () => {
  it.each([
    ['Wir könnten 2.600 Euro anbieten', 2600],
    ['Würdet ihr es für 2600€ machen?', 2600],
    ['Würdet ihr es für €2,600 machen?', 2600],
    ['How about 2600 EUR?', 2600],
    ['Wie wäre es mit 2 600 € ?', 2600],
    ['Maximal 2.600,50 Euro', 2600.5],
    ['Wir zahlen EUR 2600.00 total', 2600],
    ['2600 euros would work', 2600],
    ['Ihr Preis ist 3.948,30 € — wir bieten 3.948,30 €', 3948.3],
  ])('%s → %s', (t, v) => expect(detectCounterOfferAmount(t)).toBe(v));

  it.each([
    ['kein Betrag', 'Hallo, wir kommen am Freitag'],
    ['ohne Währung', 'Würdet ihr es für 2600 machen?'],
    ['zwei Beträge', 'Wir bieten 2.600 € statt 3.000 €'],
    ['Rabatt', 'Könnt ihr uns 200 € Rabatt geben?'],
    ['pro Nacht', 'Wir zahlen 500 € pro Nacht'],
    ['per night', 'We can pay 500 EUR per night'],
    ['/Nacht', 'maximal 500€/Nacht'],
    ['pro Person', '300 Euro pro Person'],
    ['weniger', 'Könnt ihr 300 € weniger machen?'],
    ['Kaution', 'Kaution von 500 € ok?'],
    ['discount', 'Any chance of a 200 EUR discount?'],
    ['Null', 'Wir zahlen 0 €'],
  ])('null bei %s', (_n, t) => expect(detectCounterOfferAmount(t)).toBeNull());
});

describe('evaluateCounterOffer', () => {
  const rule = { shortNoticeDays: 7, weekend: true };
  it('Fall Daniel', () => {
    const e = evaluateCounterOffer({ offer: 2600, guestTotal: 3948.3, currency: 'EUR', stay: DANIEL, rule });
    expect(e).toEqual({
      offer: 2600, guestTotal: 3948.3, currency: 'EUR', diffAbs: 1348.3, diffPct: 34.1,
      condition: { met: true, shortNotice: true, weekend: true },
    });
  });
  it('null bei Angebot ≥ Gastpreis oder Gastpreis ≤ 0; condition null ohne Regel', () => {
    expect(evaluateCounterOffer({ offer: 4000, guestTotal: 3948.3, currency: 'EUR', stay: DANIEL, rule })).toBeNull();
    expect(evaluateCounterOffer({ offer: 1, guestTotal: 0, currency: 'EUR', stay: DANIEL, rule })).toBeNull();
    expect(evaluateCounterOffer({ offer: 2600, guestTotal: 3948.3, currency: null, stay: DANIEL, rule: null })!.condition).toBeNull();
  });
  it('nicht erfüllt', () => {
    const stay: StayFacts = { requestedAt: 'x', requestDaysBeforeArrival: 12, nightWeekdays: [1], weekendNight: false };
    expect(evaluateCounterOffer({ offer: 100, guestTotal: 200, currency: 'EUR', stay, rule })!.condition)
      .toEqual({ met: false, shortNotice: false, weekend: false });
  });
  // Prüfer-Befund 4: Nebenbeträge sind kein Gegenangebot.
  it('Plausibilitätsgrenze: Betrag unter der Hälfte des Gastbetrags → nichts anzeigen', () => {
    for (const offer of [30, 390, 1974]) {
      expect(evaluateCounterOffer({ offer, guestTotal: 3948.3, currency: 'EUR', stay: DANIEL, rule }), String(offer)).toBeNull();
    }
    expect(evaluateCounterOffer({ offer: 1975, guestTotal: 3948.3, currency: 'EUR', stay: DANIEL, rule })).not.toBeNull();
  });
});

describe('formatCounterOfferNote', () => {
  const rule = { shortNoticeDays: 7, weekend: true };
  it('Fall Daniel, estimated', () => {
    const e = evaluateCounterOffer({ offer: 2600, guestTotal: 3948.3, currency: 'EUR', stay: DANIEL, rule })!;
    const note = formatCounterOfferNote(e, true, DANIEL);
    expect(note.replace(/ /g, ' ')).toBe(
      'Betrag in der Gastnachricht 2.600 € (mögliches Gegenangebot): 1.348,30 € bzw. 34,1 % unter dem Gastpreis ca. 3.948,30 € inkl. Steuern · Nachlass-Bedingung laut Objektregel: erfüllt (Wochenende, Anfrage 3 Tage vor Anreise)',
    );
  });
  it('nicht erfüllt, actual (kein „ca.“), ohne Regel entfällt der Bedingungsteil', () => {
    const stay: StayFacts = { requestedAt: 'x', requestDaysBeforeArrival: 12, nightWeekdays: [1], weekendNight: false };
    const e = evaluateCounterOffer({ offer: 100, guestTotal: 200, currency: 'EUR', stay, rule })!;
    const n = formatCounterOfferNote(e, false, stay).replace(/ /g, ' ');
    expect(n).toContain('Gastpreis 200 € inkl. Steuern');
    expect(n).not.toContain('ca.');
    expect(n).toContain('nicht erfüllt (kein Wochenende, Anfrage 12 Tage vor Anreise)');
    const e2 = evaluateCounterOffer({ offer: 100, guestTotal: 200, currency: 'EUR', stay, rule: null })!;
    expect(formatCounterOfferNote(e2, false, stay)).not.toContain('Nachlass-Bedingung');
  });
  it('ohne Währung nur Zahl', () => {
    const e = evaluateCounterOffer({ offer: 100, guestTotal: 200, currency: null, stay: DANIEL, rule: null })!;
    expect(formatCounterOfferNote(e, false, DANIEL)).toContain('Betrag in der Gastnachricht 100 (');
  });
});

// #1243: Bedingung der Objekt-Rabattlinie als eigener Fakt (Entwurfs-Kontext, nicht nur Gegenangebot).
describe('evaluateDiscountCondition / formatDiscountConditionSentence', () => {
  const RULE = { shortNoticeDays: 7, weekend: true };
  it('Fall Daniel: erfüllt über Wochenende und Kurzfristigkeit', () => {
    expect(evaluateDiscountCondition(DANIEL, RULE)).toEqual({ met: true, shortNotice: true, weekend: true });
    expect(formatDiscountConditionSentence(DANIEL, RULE)).toBe('Nachlass-Bedingung laut Objektregel: erfüllt (Wochenende, Anfrage 3 Tage vor Anreise).');
  });
  it('Wochentage weit vorher: nicht erfüllt', () => {
    const f = computeStayFacts('2026-12-15', '2026-12-17', '2026-11-19T10:00:00.000Z');
    expect(evaluateDiscountCondition(f, RULE).met).toBe(false);
    expect(formatDiscountConditionSentence(f, RULE)).toBe('Nachlass-Bedingung laut Objektregel: nicht erfüllt (kein Wochenende, Anfrage 26 Tage vor Anreise).');
  });
  it('Anfrage 5 Tage vorher, Wochentage: erfüllt über Kurzfristigkeit; Grenze inklusive', () => {
    expect(evaluateDiscountCondition(computeStayFacts('2026-11-24', '2026-11-26', '2026-11-19T10:00:00.000Z'), RULE).met).toBe(true);
    expect(evaluateDiscountCondition(computeStayFacts('2026-11-24', '2026-11-26', '2026-11-17T10:00:00.000Z'), RULE).met).toBe(true);
    expect(evaluateDiscountCondition(computeStayFacts('2026-11-24', '2026-11-26', '2026-11-16T10:00:00.000Z'), RULE).met).toBe(false);
  });
  it('Abstand unbekannt und kein Wochenende: nicht erfüllt, ehrlich benannt', () => {
    const f = computeStayFacts('2026-12-15', '2026-12-17', null);
    expect(formatDiscountConditionSentence(f, RULE)).toBe('Nachlass-Bedingung laut Objektregel: nicht erfüllt (kein Wochenende, Abstand Anfrage–Anreise unbekannt).');
  });
});
