import { describe, it, expect, vi } from 'vitest';
import {
  selectHostExamples, buildHostExamplesBlock, findHostExamples, HOST_EXAMPLE_COUNT,
  type HostExampleQuery,
} from './host-examples.js';
import type { HostExampleCandidate } from '../repositories/host-example-repository.js';

let n = 0;
function cand(p: Partial<HostExampleCandidate> = {}): HostExampleCandidate {
  n++;
  return {
    draftId: `d${n}`, threadId: `guesty:t${n}`, listingId: 'L1', source: 'guesty',
    body: `Hallo Anna, das passt gut, ihr könnt gern ab 14 Uhr kommen. Liebe Grüße Micha (${n})`,
    sentAt: '2026-11-01T10:00:00Z', judgeCategory: null, conversionCategory: null,
    guestMessage: 'Können wir früher anreisen?', ...p,
  };
}
const query = (p: Partial<HostExampleQuery> = {}): HostExampleQuery => ({
  threadId: 'guesty:current', listingId: 'L1', source: 'guesty', guestLanguage: 'de',
  lastGuestMessage: 'Können wir früher anreisen?', judgeCategoryHint: null, conversionCategory: null, ...p,
});

describe('selectHostExamples (#1082)', () => {
  it('liefert höchstens 3 Beispiele, gleiches Objekt zuerst', () => {
    const cs = [cand({ listingId: 'OTHER' }), cand(), cand(), cand(), cand()];
    const out = selectHostExamples(cs, query());
    expect(out).toHaveLength(HOST_EXAMPLE_COUNT);
    expect(out.every((e) => e.sameObject)).toBe(true);
  });

  it('Fallback objektübergreifend bei < 3 Treffern im eigenen Objekt', () => {
    const cs = [cand({ listingId: 'OTHER', body: 'Hallo Max, gern, das geht. Liebe Grüße Micha' }), cand()];
    const out = selectHostExamples(cs, query());
    expect(out).toHaveLength(2);
    expect(out[0].sameObject).toBe(true);
    expect(out[1].sameObject).toBe(false);
  });

  it('gleiche listing_id aus anderer Quelle zählt nicht als gleiches Objekt', () => {
    const out = selectHostExamples([cand({ source: 'hostex' })], query());
    expect(out[0].sameObject).toBe(false);
  });

  it('nur gleiche Sprache — auch im Fallback', () => {
    const en = cand({ body: 'Hi Tom, thank you so much, we are looking forward to see you. Best regards Micha' });
    const out = selectHostExamples([en, cand({ listingId: 'OTHER', body: en.body })], query());
    expect(out).toHaveLength(0);
    const outEn = selectHostExamples([en], query({ guestLanguage: 'en' }));
    expect(outEn).toHaveLength(1);
  });

  it('bevorzugt gleiche Situation (Judge-Kategorie vor Nachrichten-Kategorie vor Wortähnlichkeit)', () => {
    const plain = cand({ guestMessage: 'Können wir früher anreisen?' });
    const conv = cand({ conversionCategory: 'CONFIRMED', guestMessage: 'Gibt es Handtücher?' });
    const judge = cand({ judgeCategory: 'buchungsanfrage', guestMessage: 'Wir möchten feiern.' });
    const out = selectHostExamples([plain, conv, judge], query({ judgeCategoryHint: 'buchungsanfrage', conversionCategory: 'CONFIRMED' }));
    expect(out.map((e) => e.body)).toEqual([judge.body, conv.body, plain.body]);
    expect(out[0].situationMatch).toBe(true);
    expect(out[2].situationMatch).toBe(false);
  });

  it('bei gleicher Situation: ähnlichste Gastnachricht zuerst, sonst neueste (Eingangsreihenfolge)', () => {
    const recent = cand({ guestMessage: 'Wo finde ich den Parkplatz?' });
    const similar = cand({ guestMessage: 'Hallo, können wir eventuell schon früher anreisen?' });
    const older = cand({ guestMessage: 'Wo finde ich den Parkplatz bitte?' });
    const out = selectHostExamples([recent, similar, older], query());
    expect(out[0].body).toBe(similar.body);
    expect(out[1].body).toBe(recent.body);
  });

  it('schließt den aktuellen Thread, Dubletten, Codes/Telefonnummern und Überlänge aus', () => {
    const cs = [
      cand({ threadId: 'guesty:current' }),
      cand({ body: 'Hallo Lea, der Code für den Tresor ist 4711, liebe Grüße Micha' }),
      cand({ body: 'Hallo, ' + 'sehr gern '.repeat(200) }),
      cand({ body: 'Ok' }),
      cand({ body: 'Hallo Jan, gern, das passt. Liebe Grüße Micha' }),
      cand({ body: '  hallo jan, gern,   das passt. Liebe Grüße Micha ' }),
    ];
    const out = selectHostExamples(cs, query());
    expect(out.map((e) => e.body)).toEqual(['Hallo Jan, gern, das passt. Liebe Grüße Micha']);
  });

  it('Links nur aus dem eigenen Objekt (fremde Objekt-URLs nie als Vorbild)', () => {
    const body = 'Hallo Pia, alles Wichtige steht hier: https://example.org/haus, liebe Grüße Micha';
    expect(selectHostExamples([cand({ listingId: 'OTHER', body })], query())).toHaveLength(0);
    expect(selectHostExamples([cand({ body })], query())).toHaveLength(1);
  });
});

describe('buildHostExamplesBlock (#1082)', () => {
  it('leer ohne Beispiele', () => {
    expect(buildHostExamplesBlock([])).toBe('');
  });

  it('markiert die Beispiele als „So schreibt Micha“ mit Faktensperre', () => {
    const block = buildHostExamplesBlock([
      { body: 'Hallo Anna, gern! Liebe Grüße Micha', guestMessage: 'Dürfen wir früher kommen?', sameObject: true, situationMatch: false },
      { body: 'Hallo Max, passt. Liebe Grüße Micha', guestMessage: null, sameObject: false, situationMatch: false },
    ]);
    expect(block).toContain('SO SCHREIBT MICHA');
    expect(block).toContain('KEIN Faktenübertrag');
    expect(block).toContain('Hallo Anna, gern! Liebe Grüße Micha');
    expect(block).toContain('Dürfen wir früher kommen?');
    expect(block).toContain('Beispiel 2 (anderes Objekt)');
    expect(block).toContain('### ENDE SO SCHREIBT MICHA ###');
  });

  it('kürzt lange Gastnachrichten', () => {
    const block = buildHostExamplesBlock([
      { body: 'Hallo, gern. Liebe Grüße Micha', guestMessage: 'x'.repeat(1000), sameObject: true, situationMatch: false },
    ]);
    expect(block).not.toContain('x'.repeat(400));
    expect(block).toContain('…');
  });
});

describe('findHostExamples (#1082)', () => {
  it('fragt Kandidaten ohne aktuellen Thread ab und wählt aus', () => {
    const list = vi.fn().mockReturnValue([cand(), cand()]);
    const out = findHostExamples(query(), { list, now: () => new Date('2026-11-09T12:00:00Z') });
    expect(out).toHaveLength(2);
    const arg = list.mock.calls[0][0];
    expect(arg.excludeThreadId).toBe('guesty:current');
    expect(arg.sinceIso.startsWith('2025-11-09')).toBe(true);
    expect(arg.limit).toBeGreaterThan(0);
  });
});
