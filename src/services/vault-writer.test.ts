// src/services/vault-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertUnderHeading, applySuggestion, type VaultWriterDeps } from './vault-writer.js';
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
});
