// src/services/vault-suggestion-create.test.ts
// #1295: Vault-Vorschlag per Agent-API anlegen (Validierung, Zielauflösung) + Freigabe ohne feedback_id.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createOriginSuggestion, getSuggestionById, markSuggestionApplied, markSuggestionRevoked, discardSuggestion,
} from '../repositories/feedback-repository.js';
import { applySuggestion, revokeSuggestion, type VaultWriterDeps } from './vault-writer.js';
import {
  createVaultSuggestion, approveVaultSuggestion, revokeVaultSuggestion,
  type CreateVaultSuggestionDeps, type VaultSuggestionDeps,
} from './vault-suggestion-service.js';
import type { PropertyConfig } from '../config/properties.js';

const PROPS: Record<string, Partial<PropertyConfig>> = {
  farmhouse: { slug: 'farmhouse', vaultNote: 'Gästekommunikation Farmhouse Prasser.md' },
  'bootshaus-alte-oder': { slug: 'bootshaus-alte-oder', vaultNote: 'Gästekommunikation Bootshaus.md' },
  'firenze-loft': { slug: 'firenze-loft' },
  boese: { slug: 'boese', vaultNote: '../../etc/passwd.md' },
};
const created = vi.fn();
function cdeps(): CreateVaultSuggestionDeps {
  return {
    getPropertyBySlug: (slug) => PROPS[slug] as PropertyConfig | undefined,
    createOriginSuggestion: created,
    newId: () => 'id-1',
  };
}
const base = { target_heading: '## Anti-Pattern', addition_text: '- Leerzeile nach der Anrede', rationale: 'KW 47, 3 von 4 Fällen' };

describe('createVaultSuggestion — Anlegen', () => {
  beforeEach(() => created.mockReset());

  it('je Objekt: property-Slug → prozesse/<vaultNote>, Default-Herkunft diff-auswertung', () => {
    const r = createVaultSuggestion({ ...base, property: 'bootshaus-alte-oder' }, cdeps());
    expect(r).toEqual({
      ok: true,
      suggestion: {
        id: 'id-1', status: 'pending', target_file: 'prozesse/Gästekommunikation Bootshaus.md',
        target_heading: '## Anti-Pattern', origin: 'diff-auswertung',
      },
    });
    expect(created).toHaveBeenCalledWith({
      id: 'id-1', target_file: 'prozesse/Gästekommunikation Bootshaus.md', target_heading: '## Anti-Pattern',
      addition_text: '- Leerzeile nach der Anrede', rationale: 'KW 47, 3 von 4 Fällen', origin: 'diff-auswertung',
    });
  });

  it('alle Objekte: scope "alle" → Grundsätze-Datei', () => {
    const r = createVaultSuggestion({ ...base, scope: 'alle' }, cdeps());
    expect(r).toMatchObject({ ok: true, suggestion: { target_file: 'prozesse/Gästekommunikation Grundsätze.md' } });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('Herkunft übernehmen; Pflichtfelder werden getrimmt', () => {
    const r = createVaultSuggestion({
      target_heading: '  ## Anti-Pattern ', addition_text: '\n- x\n', rationale: ' r ', property: 'farmhouse', origin: 'lint',
    }, cdeps());
    expect(r).toMatchObject({ ok: true, suggestion: { origin: 'lint', target_heading: '## Anti-Pattern' } });
    expect(created.mock.calls[0][0]).toMatchObject({ addition_text: '- x', rationale: 'r', target_heading: '## Anti-Pattern' });
  });
});

describe('createVaultSuggestion — 400', () => {
  beforeEach(() => created.mockReset());
  const cases: [string, unknown][] = [
    ['kein Objekt-Body', null],
    ['Array-Body', []],
    ['target_heading fehlt', { addition_text: '- x', rationale: 'r', scope: 'alle' }],
    ['addition_text fehlt', { target_heading: '## A', rationale: 'r', scope: 'alle' }],
    ['rationale fehlt', { target_heading: '## A', addition_text: '- x', scope: 'alle' }],
    ['leerer Zusatztext', { ...base, addition_text: '   ', scope: 'alle' }],
    ['Zusatztext keine Zeichenkette', { ...base, addition_text: 5, scope: 'alle' }],
    ['Überschrift ohne #', { ...base, target_heading: 'Anti-Pattern', scope: 'alle' }],
    ['Überschrift mehrzeilig', { ...base, target_heading: '## A\n## B', scope: 'alle' }],
    ['weder property noch scope', { ...base }],
    ['property und scope', { ...base, property: 'farmhouse', scope: 'alle' }],
    ['scope ungleich alle', { ...base, scope: 'farmhouse' }],
    ['unbekannter Slug', { ...base, property: 'gibt-es-nicht' }],
    ['Objekt ohne vaultNote', { ...base, property: 'firenze-loft' }],
    ['unsicheres Ziel (Guard aus vault-writer)', { ...base, property: 'boese' }],
    ['Herkunft feedback ist dem Feedback-Loop vorbehalten', { ...base, scope: 'alle', origin: 'feedback' }],
    ['Herkunft mit ungültigen Zeichen', { ...base, scope: 'alle', origin: 'Diff Auswertung!' }],
    ['unbekanntes Feld', { ...base, scope: 'alle', heading: '## A' }],
  ];
  it.each(cases)('%s', (_name, body) => {
    const r = createVaultSuggestion(body, cdeps());
    expect(r).toEqual({ ok: false, status: 400, error: expect.any(String) });
    expect(created).not.toHaveBeenCalled();
  });
});

// Freigabe/Revoke/Verwerfen eines Vorschlags ohne feedback_id gegen echte Migrationen + echtes Git-Vault.
describe('Vorschlag ohne feedback_id: Freigabe schreibt ins Vault', () => {
  const REL = 'prozesse/Gästekommunikation Grundsätze.md';
  const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');
  let db: Database.Database;
  let vault: string;
  const syncVault = vi.fn();
  const wdeps = (): VaultWriterDeps => ({
    vaultPath: vault,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c),
    git: (args) => String(execFileSync('git', ['-C', vault, ...args])),
  });
  const deps = (): VaultSuggestionDeps => ({
    getSuggestionById, markSuggestionApplied, markSuggestionRevoked,
    applySuggestion: (s) => applySuggestion(s, wdeps()),
    revokeSuggestion: (s) => revokeSuggestion(s, wdeps()),
    syncVault: syncVault as never,
  });

  beforeEach(() => {
    syncVault.mockReset().mockReturnValue({ synced: true, pushed: true });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of ['020_add_feedback_and_suggestions.sql', '038_add_vault_suggestion_revoke.sql', '046_vault_suggestion_origin.sql']) db.exec(mig(m));
    setDatabase(db);
    vault = mkdtempSync(join(tmpdir(), 'vault-create-'));
    mkdirSync(join(vault, 'prozesse'), { recursive: true });
    writeFileSync(join(vault, REL), '# Voice\n## Anti-Pattern\n- alt\n\n## Sonstiges\n- y\n');
    execFileSync('git', ['-C', vault, 'init', '-q']);
    execFileSync('git', ['-C', vault, 'config', 'user.email', 't@t.de']);
    execFileSync('git', ['-C', vault, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', vault, 'add', '.']);
    execFileSync('git', ['-C', vault, 'commit', '-qm', 'init']);
  });
  afterEach(() => { resetDatabase(); db.close(); rmSync(vault, { recursive: true, force: true }); });

  const create = () => {
    const r = createVaultSuggestion({ ...base, scope: 'alle' }, { getPropertyBySlug: () => undefined, createOriginSuggestion, newId: () => 'o1' });
    expect(r.ok).toBe(true);
  };

  it('anlegen → freigeben → zurückziehen', () => {
    create();
    expect(getSuggestionById('o1')).toMatchObject({ status: 'pending', feedback_id: null, origin: 'diff-auswertung' });

    expect(approveVaultSuggestion('o1', deps())).toMatchObject({ ok: true, pushed: true });
    expect(readFileSync(join(vault, REL), 'utf8')).toBe('# Voice\n## Anti-Pattern\n- alt\n- Leerzeile nach der Anrede\n\n## Sonstiges\n- y\n');
    const s = getSuggestionById('o1')!;
    expect(s.status).toBe('approved');
    expect(s.applied_commit).toMatch(/^[0-9a-f]{7,}/);
    expect(execFileSync('git', ['-C', vault, 'log', '-1', '--format=%s']).toString().trim()).toBe('Vault-Update via Feedback-Loop (## Anti-Pattern)');

    expect(revokeVaultSuggestion('o1', deps())).toMatchObject({ ok: true, removed: true });
    expect(getSuggestionById('o1')!.status).toBe('revoked');
    expect(readFileSync(join(vault, REL), 'utf8')).toBe('# Voice\n## Anti-Pattern\n- alt\n\n## Sonstiges\n- y\n');
  });

  it('verwerfen ohne feedback_id', () => {
    create();
    expect(discardSuggestion('o1')).toBe(true);
    expect(getSuggestionById('o1')!.status).toBe('discarded');
  });
});
