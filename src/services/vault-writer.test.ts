// src/services/vault-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertUnderHeading, removeUnderHeading, applySuggestion, revokeSuggestion, type VaultWriterDeps } from './vault-writer.js';
import type { VaultSuggestion } from '../types/feedback.js';

describe('insertUnderHeading (pure)', () => {
  it('appends at the END of the target section (before the next ## heading)', () => {
    const src = '# T\n## A\n- a1\n\n## B\n- b1\n';
    const out = insertUnderHeading(src, '## A', '- a2');
    expect(out).toBe('# T\n## A\n- a1\n- a2\n\n## B\n- b1\n');
  });
  it('appends heading + text at EOF when the heading is absent', () => {
    const out = insertUnderHeading('# T\n## A\n- a1\n', '## Neu', '- x');
    expect(out).toContain('## Neu\n- x');
  });
});

describe('removeUnderHeading (pure)', () => {
  it('entfernt genau die Zeile im Abschnitt, ohne Leerzeilen anzufassen', () => {
    const src = '# T\n## A\n- a1\n- a2\n\n## B\n- b1\n';
    const r = removeUnderHeading(src, '## A', '- a2');
    expect(r).toEqual({ content: '# T\n## A\n- a1\n\n## B\n- b1\n', removed: true });
  });
  it('gleiche Zeile in anderem Abschnitt bleibt stehen', () => {
    const src = '## A\n- x\n## B\n- x\n- y\n';
    const r = removeUnderHeading(src, '## B', '- x');
    expect(r.content).toBe('## A\n- x\n## B\n- y\n');
  });
  it('entfernt einen mehrzeiligen zusammenhängenden Block (trim-Vergleich)', () => {
    const src = '## A\n- k\n  - u1  \n  - u2\n- z\n';
    const r = removeUnderHeading(src, '## A', '- k\n- u1\n- u2');
    expect(r).toEqual({ content: '## A\n- z\n', removed: true });
  });
  it('nicht gefunden / Überschrift fehlt -> removed false, content unverändert', () => {
    const src = '## A\n- a1\n';
    expect(removeUnderHeading(src, '## A', '- nope')).toEqual({ content: src, removed: false });
    expect(removeUnderHeading(src, '## Fehlt', '- a1')).toEqual({ content: src, removed: false });
  });
});

describe('applySuggestion (temp git repo)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'vault-w-'));
    mkdirSync(join(base, 'prozesse'), { recursive: true });
    writeFileSync(join(base, 'prozesse/Gästekommunikation Grundsätze.md'), '# Voice\n## Anti-Pattern\n- alt\n');
    execFileSync('git', ['-C', base, 'init', '-q']);
    execFileSync('git', ['-C', base, 'config', 'user.email', 't@t.de']);
    execFileSync('git', ['-C', base, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', base, 'add', '.']);
    execFileSync('git', ['-C', base, 'commit', '-qm', 'init']);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  function deps(): VaultWriterDeps {
    return {
      vaultPath: base,
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, c) => writeFileSync(p, c),
      git: (args) => String(execFileSync('git', ['-C', base, ...args])),
    };
  }
  const sug = (over: Partial<VaultSuggestion> = {}): VaultSuggestion => ({
    id: 's', feedback_id: 'f', target_file: 'prozesse/Gästekommunikation Grundsätze.md', target_heading: '## Anti-Pattern',
    addition_text: '- neu', rationale: 'r', status: 'pending', applied_commit: null, applied_at: null, ...over,
  });

  it('appends the addition to the file and commits', () => {
    const res = applySuggestion(sug(), deps());
    expect(res.committed).toBe(true);
    expect(res.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(readFileSync(join(base, 'prozesse/Gästekommunikation Grundsätze.md'), 'utf8')).toContain('- alt\n- neu');
  });

  it('is idempotent — applying the same suggestion twice appends the addition only once', () => {
    applySuggestion(sug(), deps());
    applySuggestion(sug(), deps()); // simulates a re-approve after a partial failure
    const content = readFileSync(join(base, 'prozesse/Gästekommunikation Grundsätze.md'), 'utf8');
    expect(content.split('- neu').length - 1).toBe(1);
  });

  it('rejects an unsafe target_file without writing', () => {
    const res = applySuggestion(sug({ target_file: 'prozesse/../../secret.md' }), deps());
    expect(res.committed).toBe(false);
    expect(res.error).toMatch(/unsafe/i);
    // The vault file is untouched — the guard fired before any write.
    expect(readFileSync(join(base, 'prozesse/Gästekommunikation Grundsätze.md'), 'utf8')).toBe('# Voice\n## Anti-Pattern\n- alt\n');
  });

  const FILE = 'Gästekommunikation Grundsätze.md';
  const read = () => readFileSync(join(base, 'prozesse', FILE), 'utf8');
  const head = () => execFileSync('git', ['-C', base, 'rev-parse', 'HEAD']).toString().trim();
  const lastMsg = () => execFileSync('git', ['-C', base, 'log', '-1', '--format=%s']).toString().trim();

  it('Approve -> Revoke -> Approve ergibt genau EINE Zeile, Datei sonst unverändert', () => {
    const orig = read();
    expect(applySuggestion(sug(), deps()).committed).toBe(true);
    const rev = revokeSuggestion(sug(), deps());
    expect(rev).toMatchObject({ committed: true, removed: true });
    expect(rev.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(read()).toBe(orig);
    expect(applySuggestion(sug(), deps()).committed).toBe(true);
    expect(read().split('- neu').length - 1).toBe(1);
  });

  it('Revoke-Commit-Message exakt', () => {
    applySuggestion(sug(), deps());
    revokeSuggestion(sug(), deps());
    expect(lastMsg()).toBe('Vault-Update zurückgezogen (## Anti-Pattern)');
  });

  it('zweiter Revoke ist idempotent (kein Commit, kein Fehler, HEAD gleich)', () => {
    applySuggestion(sug(), deps());
    revokeSuggestion(sug(), deps());
    const h = head();
    const res = revokeSuggestion(sug(), deps());
    expect(res).toEqual({ committed: false, commit: null, removed: false });
    expect(head()).toBe(h);
  });

  it('zwei Vorschläge in derselben Datei: Revoke des einen lässt den anderen stehen', () => {
    applySuggestion(sug({ id: 'a', addition_text: '- eins' }), deps());
    applySuggestion(sug({ id: 'b', addition_text: '- zwei' }), deps());
    revokeSuggestion(sug({ id: 'a', addition_text: '- eins' }), deps());
    expect(read()).toBe('# Voice\n## Anti-Pattern\n- alt\n- zwei\n');
  });

  it('Re-Approve bei bereits vorhandener Zeile: kein Commit, kein Fehler', () => {
    applySuggestion(sug(), deps());
    const h = head();
    const res = applySuggestion(sug(), deps());
    expect(res).toEqual({ committed: false, commit: null });
    expect(head()).toBe(h);
  });

  it('Revoke lehnt unsicheren Pfad ab', () => {
    const res = revokeSuggestion(sug({ target_file: 'prozesse/../x.md' }), deps());
    expect(res.error).toMatch(/unsafe/i);
  });
});
