// src/services/vault-sync.test.ts
import { describe, it, expect } from 'vitest';
import { syncVault, type VaultSyncDeps } from './vault-sync.js';

/** Fake-git: zeichnet Aufrufe auf; wirft für Subkommandos in `fail` ('abort' schaltet merge --abort). */
function fakeDeps(fail: string[] = []) {
  const calls: string[][] = [];
  const deps: VaultSyncDeps = {
    vaultPath: '/vault',
    git: (args) => {
      calls.push(args);
      if (args[0] === 'merge' && args[1] === '--abort') {
        if (fail.includes('abort')) throw new Error('abort kaputt');
        return '';
      }
      if (fail.includes(args[0])) throw new Error(`${args[0]} kaputt`);
      return '';
    },
  };
  return { deps, calls };
}

describe('syncVault', () => {
  it('happy path: fetch → merge → push, synced+pushed', () => {
    const { deps, calls } = fakeDeps();
    const res = syncVault(deps);
    expect(res).toEqual({ synced: true, pushed: true });
    expect(calls).toEqual([
      ['fetch', 'origin'],
      ['merge', 'origin/main', '--no-edit'],
      ['push', 'origin', 'main'],
    ]);
  });

  it('push schlägt fehl → synced true, pushed false, Fehler benannt', () => {
    const { deps } = fakeDeps(['push']);
    const res = syncVault(deps);
    expect(res.synced).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.error).toContain('push failed');
  });

  it('fetch schlägt fehl (offline) → kein merge/push versucht', () => {
    const { deps, calls } = fakeDeps(['fetch']);
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('fetch failed');
    expect(calls).toEqual([['fetch', 'origin']]);
  });

  it('merge schlägt fehl → merge --abort wird aufgerufen, kein push', () => {
    const { deps, calls } = fakeDeps(['merge']);
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('merge failed');
    expect(calls).toContainEqual(['merge', '--abort']);
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('merge UND abort schlagen fehl → beide Fehler im Ergebnis, nichts geworfen', () => {
    const { deps } = fakeDeps(['merge', 'abort']);
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('merge failed');
    expect(res.error).toContain('abort failed');
  });

  it('ohne vaultPath: No-op ohne git-Aufrufe, kein Fehler', () => {
    const calls: string[][] = [];
    const deps: VaultSyncDeps = {
      vaultPath: undefined,
      git: (args) => { calls.push(args); return ''; },
    };
    const res = syncVault(deps);
    expect(res).toEqual({ synced: false, pushed: false });
    expect(calls).toEqual([]);
  });
});
