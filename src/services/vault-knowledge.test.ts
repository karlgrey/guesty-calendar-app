import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVoice, loadPropertyFacts } from './vault-knowledge.js';

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(base, 'prozesse'), { recursive: true });
  writeFileSync(join(base, 'prozesse/Gästekommunikation Grundsätze.md'), 'VOICE-TEXT');
  writeFileSync(join(base, 'prozesse/Gästekommunikation Bootshaus.md'), 'BOOTSHAUS-FACTS');
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

describe('vault-knowledge', () => {
  it('reads voice and property facts from the vault base dir', () => {
    expect(loadVoice(base)).toBe('VOICE-TEXT');
    expect(loadPropertyFacts('Gästekommunikation Bootshaus.md', base)).toBe('BOOTSHAUS-FACTS');
  });

  it('returns null when base dir is falsy (feature off / no VAULT_PATH)', () => {
    // Pass '' (falsy but not undefined) so we exercise the !baseDir guard directly,
    // independent of whether config.vaultPath is set — `undefined` would trigger the
    // `= config.vaultPath` default parameter and read the real vault.
    expect(loadVoice('')).toBeNull();
    expect(loadPropertyFacts('Gästekommunikation Bootshaus.md', '')).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(loadPropertyFacts('DoesNotExist.md', base)).toBeNull();
  });

  it('rejects path-traversal / non-simple note names', () => {
    expect(loadPropertyFacts('../secret.md', base)).toBeNull();
    expect(loadPropertyFacts('sub/dir.md', base)).toBeNull();
    expect(loadPropertyFacts('Bootshaus.txt', base)).toBeNull();
  });
});
