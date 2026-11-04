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
