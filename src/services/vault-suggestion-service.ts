// src/services/vault-suggestion-service.ts
// Freigabe und Rücknahme von Vault-Vorschlägen (#969) — gemeinsamer Weg für Admin-UI und Agent-API.
import {
  getSuggestionById, markSuggestionApplied, markSuggestionRevoked,
} from '../repositories/feedback-repository.js';
import { applySuggestion, revokeSuggestion } from './vault-writer.js';
import { syncVault } from './vault-sync.js';
import logger from '../utils/logger.js';
import type { VaultSuggestion } from '../types/feedback.js';

export interface VaultSuggestionDeps {
  getSuggestionById: (id: string) => VaultSuggestion | null;
  markSuggestionApplied: (id: string, commit: string | null) => void;
  markSuggestionRevoked: (id: string, commit: string | null) => void;
  applySuggestion: typeof applySuggestion;
  revokeSuggestion: typeof revokeSuggestion;
  syncVault: typeof syncVault;
}

function defaultDeps(): VaultSuggestionDeps {
  return { getSuggestionById, markSuggestionApplied, markSuggestionRevoked, applySuggestion, revokeSuggestion, syncVault };
}

export type VaultSuggestionResult =
  | { ok: true; suggestion: VaultSuggestion; pushed: boolean; removed?: boolean; alreadyRevoked?: boolean }
  | { ok: false; status: 404 | 409 | 502; error: string };

function syncNonFatal(deps: VaultSuggestionDeps, ctx: string): boolean {
  const sync = deps.syncVault();
  if (sync.error) logger.warn({ error: sync.error }, `Vault-Sync nach ${ctx} (non-fatal)`);
  return sync.pushed;
}

/** Freigabe: erlaubt bei 'pending' und 'revoked' (Re-Approve nach Rücknahme). */
export function approveVaultSuggestion(id: string, deps: VaultSuggestionDeps = defaultDeps()): VaultSuggestionResult {
  const s = deps.getSuggestionById(id);
  if (!s) return { ok: false, status: 404, error: 'Vorschlag nicht gefunden' };
  if (s.status !== 'pending' && s.status !== 'revoked') {
    return { ok: false, status: 409, error: 'Vorschlag ist nicht mehr offen' };
  }
  const result = deps.applySuggestion(s);
  if (!result.committed && result.error) {
    return { ok: false, status: 502, error: `Schreiben fehlgeschlagen: ${result.error}` };
  }
  deps.markSuggestionApplied(s.id, result.commit);
  const pushed = syncNonFatal(deps, 'Freigabe');
  return { ok: true, suggestion: deps.getSuggestionById(id) ?? s, pushed };
}

/** Rücknahme eines freigegebenen Vorschlags. Bereits zurückgezogen → idempotent OK. */
export function revokeVaultSuggestion(id: string, deps: VaultSuggestionDeps = defaultDeps()): VaultSuggestionResult {
  const s = deps.getSuggestionById(id);
  if (!s) return { ok: false, status: 404, error: 'Vorschlag nicht gefunden' };
  if (s.status === 'revoked') return { ok: true, suggestion: s, pushed: false, removed: false, alreadyRevoked: true };
  if (s.status !== 'approved') {
    return { ok: false, status: 409, error: 'Nur freigegebene Vorschläge können zurückgezogen werden' };
  }
  const result = deps.revokeSuggestion(s);
  if (result.error) return { ok: false, status: 502, error: `Zurückziehen fehlgeschlagen: ${result.error}` };
  deps.markSuggestionRevoked(s.id, result.commit);
  const pushed = syncNonFatal(deps, 'Rücknahme');
  return { ok: true, suggestion: deps.getSuggestionById(id) ?? s, pushed, removed: result.removed, alreadyRevoked: false };
}
