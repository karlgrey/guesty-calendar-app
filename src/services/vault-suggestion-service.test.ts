// src/services/vault-suggestion-service.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createFeedback, createSuggestion, getSuggestionById, discardSuggestion,
  markSuggestionApplied, markSuggestionRevoked,
} from '../repositories/feedback-repository.js';
import { applySuggestion, revokeSuggestion, type VaultWriterDeps } from './vault-writer.js';
import { approveVaultSuggestion, revokeVaultSuggestion, type VaultSuggestionDeps } from './vault-suggestion-service.js';

const REL = 'prozesse/Gästekommunikation Grundsätze.md';
let db: Database.Database;
let base: string;
const syncVault = vi.fn();

function wdeps(): VaultWriterDeps {
  return {
    vaultPath: base,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c),
    git: (args) => String(execFileSync('git', ['-C', base, ...args])),
  };
}
function deps(): VaultSuggestionDeps {
  return {
    getSuggestionById, markSuggestionApplied, markSuggestionRevoked,
    applySuggestion: (s) => applySuggestion(s, wdeps()),
    revokeSuggestion: (s) => revokeSuggestion(s, wdeps()),
    syncVault: syncVault as never,
  };
}
const head = () => execFileSync('git', ['-C', base, 'rev-parse', 'HEAD']).toString().trim();

beforeEach(() => {
  syncVault.mockReset().mockReturnValue({ synced: true, pushed: true });
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE draft_feedback (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, draft_id TEXT, category TEXT NOT NULL,
      note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_suggestions (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, target_file TEXT NOT NULL,
      target_heading TEXT NOT NULL, addition_text TEXT NOT NULL, rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', applied_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT,
      revoked_at TEXT, revoke_commit TEXT
    );
  `);
  setDatabase(db);
  createFeedback({ id: 'fb', thread_id: 't', draft_id: 'd', category: 'ton', note: 'n' });
  createSuggestion({ id: 's1', feedback_id: 'fb', target_file: REL, target_heading: '## Anti-Pattern', addition_text: '- neu', rationale: 'r' });

  base = mkdtempSync(join(tmpdir(), 'vault-svc-'));
  mkdirSync(join(base, 'prozesse'), { recursive: true });
  writeFileSync(join(base, REL), '# Voice\n## Anti-Pattern\n- alt\n');
  execFileSync('git', ['-C', base, 'init', '-q']);
  execFileSync('git', ['-C', base, 'config', 'user.email', 't@t.de']);
  execFileSync('git', ['-C', base, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', base, 'add', '.']);
  execFileSync('git', ['-C', base, 'commit', '-qm', 'init']);
});
afterEach(() => { resetDatabase(); db.close(); rmSync(base, { recursive: true, force: true }); });

describe('vault-suggestion-service', () => {
  it('approved -> revoked -> approved, Datei am Ende mit genau einer Zeile', () => {
    const a = approveVaultSuggestion('s1', deps());
    expect(a).toMatchObject({ ok: true, pushed: true });
    expect(getSuggestionById('s1')?.status).toBe('approved');

    const r = revokeVaultSuggestion('s1', deps());
    expect(r).toMatchObject({ ok: true, removed: true, alreadyRevoked: false });
    const s = getSuggestionById('s1')!;
    expect(s.status).toBe('revoked');
    expect(s.revoke_commit).toMatch(/^[0-9a-f]{7,}/);
    expect(s.revoked_at).not.toBeNull();
    expect(readFileSync(join(base, REL), 'utf8')).toBe('# Voice\n## Anti-Pattern\n- alt\n');

    const a2 = approveVaultSuggestion('s1', deps());
    expect(a2.ok).toBe(true);
    const s2 = getSuggestionById('s1')!;
    expect(s2.status).toBe('approved');
    expect(s2.revoked_at).toBeNull();
    expect(readFileSync(join(base, REL), 'utf8').split('- neu').length - 1).toBe(1);
  });

  it('404 bei unbekannter ID', () => {
    expect(approveVaultSuggestion('x', deps())).toEqual({ ok: false, status: 404, error: expect.any(String) });
    expect(revokeVaultSuggestion('x', deps())).toMatchObject({ ok: false, status: 404 });
  });

  it('409: Approve bei approved/discarded, Revoke bei pending/discarded', () => {
    expect(revokeVaultSuggestion('s1', deps())).toMatchObject({ ok: false, status: 409 });
    approveVaultSuggestion('s1', deps());
    expect(approveVaultSuggestion('s1', deps())).toMatchObject({ ok: false, status: 409 });
    createSuggestion({ id: 's2', feedback_id: 'fb', target_file: REL, target_heading: '## Anti-Pattern', addition_text: '- zwei', rationale: 'r' });
    discardSuggestion('s2');
    expect(approveVaultSuggestion('s2', deps())).toMatchObject({ ok: false, status: 409 });
    expect(revokeVaultSuggestion('s2', deps())).toMatchObject({ ok: false, status: 409 });
  });

  it('alreadyRevoked: idempotent, kein Commit, kein Sync', () => {
    approveVaultSuggestion('s1', deps());
    revokeVaultSuggestion('s1', deps());
    syncVault.mockClear();
    const h = head();
    const r = revokeVaultSuggestion('s1', deps());
    expect(r).toMatchObject({ ok: true, alreadyRevoked: true });
    expect(head()).toBe(h);
    expect(syncVault).not.toHaveBeenCalled();
  });

  it('syncVault läuft nach Revoke; Sync-Fehler ist non-fatal', () => {
    approveVaultSuggestion('s1', deps());
    syncVault.mockClear().mockReturnValue({ synced: false, pushed: false, error: 'fetch failed' });
    const r = revokeVaultSuggestion('s1', deps());
    expect(syncVault).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, pushed: false });
    expect(getSuggestionById('s1')?.status).toBe('revoked');
  });

  it('Revoke bei bereits fehlender Zeile: removed false, Status trotzdem revoked, revoke_commit null', () => {
    approveVaultSuggestion('s1', deps());
    writeFileSync(join(base, REL), '# Voice\n## Anti-Pattern\n- alt\n');
    const r = revokeVaultSuggestion('s1', deps());
    expect(r).toMatchObject({ ok: true, removed: false });
    expect(getSuggestionById('s1')).toMatchObject({ status: 'revoked', revoke_commit: null });
  });

  it('502 wenn der Vault-Writer fehlschlägt, Status bleibt approved', () => {
    approveVaultSuggestion('s1', deps());
    const d = { ...deps(), revokeSuggestion: () => ({ committed: false, commit: null, removed: false, error: 'git failed' }) };
    expect(revokeVaultSuggestion('s1', d)).toMatchObject({ ok: false, status: 502 });
    expect(getSuggestionById('s1')?.status).toBe('approved');
  });
});
