import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPropertyBySlug } from '../config/properties.js';
import type { DraftCase } from './test-draft-fixtures.js';

// Schema-Test für src/test-fixtures/drafts/cases.json (#976) — kein API-Aufruf.
const cases = JSON.parse(
  readFileSync(new URL('../test-fixtures/drafts/cases.json', import.meta.url), 'utf8'),
) as DraftCase[];

describe('drafts/cases.json', () => {
  it('enthält Fälle mit eindeutigen Namen', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });
  for (const c of cases) {
    describe(c.name, () => {
      it('hat Pflichtfelder', () => {
        expect(c.name).toBeTruthy();
        expect(c.description).toBeTruthy();
        expect(c.messages.length).toBeGreaterThanOrEqual(1);
        expect(c.messages.every((m) => ['inbound', 'outbound', 'system'].includes(m.direction) && m.body)).toBe(true);
        expect(c.expect).toBeTypeOf('object');
        expect(Object.keys(c.expect).length).toBeGreaterThan(0);
        expect(c.thread.channel).toBeTruthy();
        expect(c.alteration === null || ['pending_request', 'guest_reports_change'].includes(c.alteration.kind)).toBe(true);
        if (c.now) expect(Number.isNaN(Date.parse(c.now))).toBe(false);
      });
      it('propertySlug existiert samt Vault-Notiz', () => {
        const p = getPropertyBySlug(c.propertySlug);
        expect(p).toBeDefined();
        expect(p?.vaultNote).toBeTruthy();
      });
    });
  }
});

// #1312: Abnahme-Fixtures Höflichkeitsantworten (Live-Lauf: npm run test:drafts -- --case 1312).
describe('drafts/cases.json — #1312 Höflichkeitsantworten', () => {
  const byName = (part: string) => cases.find((c) => c.name.includes(part));
  it('reiner Dank „Vielen Dank, hat alles super geklappt!“ erwartet einen kurzen Entwurf ohne Rückfrage', () => {
    const c = byName('reiner Dank, kurze Höflichkeit (#1312)');
    expect(c).toBeDefined();
    expect(c!.messages.at(-1)).toMatchObject({ direction: 'inbound', body: 'Vielen Dank, hat alles super geklappt!' });
    expect(c!.messages.some((m) => m.direction === 'outbound')).toBe(false);
    expect(c!.expect.noReply).toBeFalsy();
    expect(c!.expect.maxSentences).toBeLessThanOrEqual(2);
    expect(c!.expect.mustNotContain).toContain('?');
  });
  it('nur Emoji erwartet weiter no_reply', () => {
    const c = byName('nur Emoji (#1312)');
    expect(c).toBeDefined();
    const last = c!.messages.at(-1)!;
    expect(last.direction).toBe('inbound');
    expect(last.body).not.toMatch(/[\p{L}\p{N}]/u);
    expect(c!.expect).toEqual({ noReply: true });
  });
  it('Dank nach unserer eigenen Höflichkeitsantwort erwartet no_reply (kein Ping-Pong)', () => {
    const c = byName('Dank nach unserer Höflichkeit (#1312)');
    expect(c).toBeDefined();
    const dirs = c!.messages.map((m) => m.direction);
    expect(dirs.slice(-2)).toEqual(['outbound', 'inbound']);
    expect(c!.expect).toEqual({ noReply: true });
  });
  it('kein Fall erwartet mehr no_reply für reinen Dank ohne vorherige Host-Höflichkeit', () => {
    for (const c of cases.filter((x) => x.expect.noReply)) {
      const lastInbound = [...c.messages].reverse().find((m) => m.direction === 'inbound')!;
      const emojiOnly = !/[\p{L}\p{N}]/u.test(lastInbound.body);
      const afterHost = c.messages.at(-2)?.direction === 'outbound';
      expect(emojiOnly || afterHost, c.name).toBe(true);
    }
  });
});
