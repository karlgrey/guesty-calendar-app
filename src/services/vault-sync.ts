// src/services/vault-sync.ts
import { execFileSync } from 'node:child_process';
import { config } from '../config/index.js';

export interface VaultSyncDeps {
  vaultPath: string | undefined;
  git: (args: string[]) => string;
}

export interface VaultSyncResult {
  synced: boolean;
  pushed: boolean;
  error?: string;
}

const GIT_TIMEOUT_MS = 30_000;

function defaultDeps(): VaultSyncDeps {
  const vaultPath = config.vaultPath;
  return {
    vaultPath,
    git: (args) =>
      String(execFileSync('git', ['-C', vaultPath as string, ...args], { timeout: GIT_TIMEOUT_MS })),
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Synct den Vault mit origin/main: fetch → merge (kein Rebase) → push.
 * Wirft NIE — Fehler landen im Rückgabewert. Ohne VAULT_PATH: No-op.
 */
export function syncVault(deps: VaultSyncDeps = defaultDeps()): VaultSyncResult {
  if (!deps.vaultPath) return { synced: false, pushed: false };

  try {
    deps.git(['fetch', 'origin']);
  } catch (err) {
    return { synced: false, pushed: false, error: `fetch failed: ${msg(err)}` };
  }

  try {
    deps.git(['merge', 'origin/main', '--no-edit']);
  } catch (mergeErr) {
    try {
      deps.git(['merge', '--abort']);
      return { synced: false, pushed: false, error: `merge failed (aborted): ${msg(mergeErr)}` };
    } catch (abortErr) {
      return {
        synced: false,
        pushed: false,
        error: `merge failed: ${msg(mergeErr)}; abort failed: ${msg(abortErr)}`,
      };
    }
  }

  try {
    deps.git(['push', 'origin', 'main']);
  } catch (err) {
    return { synced: true, pushed: false, error: `push failed: ${msg(err)}` };
  }

  return { synced: true, pushed: true };
}
