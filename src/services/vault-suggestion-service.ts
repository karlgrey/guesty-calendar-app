// src/services/vault-suggestion-service.ts
// Freigabe und Rücknahme von Vault-Vorschlägen (#969) — gemeinsamer Weg für Admin-UI und Agent-API.
import { randomUUID } from 'node:crypto';
import {
  getSuggestionById, markSuggestionApplied, markSuggestionRevoked, createOriginSuggestion,
} from '../repositories/feedback-repository.js';
import { applySuggestion, revokeSuggestion, isSafeTargetFile } from './vault-writer.js';
import { syncVault } from './vault-sync.js';
import { getPropertyBySlug } from '../config/properties.js';
import type { PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';
import { FEEDBACK_ORIGIN, type NewOriginSuggestion, type VaultSuggestion } from '../types/feedback.js';

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

// ---------------------------------------------------------------------------
// #1295 Anlegen per Agent-API (Diff-Auswertung): ohne feedback_id, mit Herkunft
// ---------------------------------------------------------------------------

/** Ziel für `scope: "alle"` (dieselbe Datei wie der Ton-Zweig des Feedback-Loops in messages.ts). */
export const ALL_PROPERTIES_TARGET = 'prozesse/Gästekommunikation Grundsätze.md';
export const DEFAULT_AGENT_ORIGIN = 'diff-auswertung';
const ALLOWED_FIELDS = new Set(['target_heading', 'addition_text', 'rationale', 'property', 'scope', 'origin']);
const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEADING_PATTERN = /^#{1,6}\s+\S/;
const MAX_HEADING = 200;
const MAX_TEXT = 4000;

export interface CreateVaultSuggestionDeps {
  getPropertyBySlug: (slug: string) => PropertyConfig | undefined;
  createOriginSuggestion: (s: NewOriginSuggestion) => void;
  newId: () => string;
}

function defaultCreateDeps(): CreateVaultSuggestionDeps {
  return { getPropertyBySlug, createOriginSuggestion, newId: randomUUID };
}

export type CreateVaultSuggestionResult =
  | { ok: true; suggestion: { id: string; status: 'pending'; target_file: string; target_heading: string; origin: string } }
  | { ok: false; status: 400; error: string };

const bad = (error: string): CreateVaultSuggestionResult => ({ ok: false, status: 400, error });

function requiredText(body: Record<string, unknown>, field: string, max: number): string | { error: string } {
  const v = body[field];
  if (typeof v !== 'string' || !v.trim()) return { error: `${field} ist Pflicht (nicht-leere Zeichenkette)` };
  const t = v.trim();
  if (t.length > max) return { error: `${field} ist zu lang (max. ${max} Zeichen)` };
  return t;
}

/**
 * Legt einen Vault-Vorschlag ohne Entwurfs-Feedback an (Status pending). Ziel: genau eines von
 * `property` (Slug → `prozesse/<vaultNote>`) oder `scope: "alle"` (Grundsätze). Der target_file-Guard
 * aus vault-writer gilt schon hier. Freigabe/Revoke/Verwerfen laufen danach unverändert.
 */
export function createVaultSuggestion(
  body: unknown, deps: CreateVaultSuggestionDeps = defaultCreateDeps(),
): CreateVaultSuggestionResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Body muss ein JSON-Objekt sein');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknown.length) return bad(`Unbekannte Felder: ${unknown.join(', ')}`);

  const heading = requiredText(b, 'target_heading', MAX_HEADING);
  if (typeof heading !== 'string') return bad(heading.error);
  if (heading.includes('\n') || !HEADING_PATTERN.test(heading)) {
    return bad('target_heading muss eine einzeilige Markdown-Überschrift sein (z. B. „## Anti-Pattern")');
  }
  const addition = requiredText(b, 'addition_text', MAX_TEXT);
  if (typeof addition !== 'string') return bad(addition.error);
  const rationale = requiredText(b, 'rationale', MAX_TEXT);
  if (typeof rationale !== 'string') return bad(rationale.error);

  let origin = DEFAULT_AGENT_ORIGIN;
  if (b.origin !== undefined) {
    if (typeof b.origin !== 'string' || !ORIGIN_PATTERN.test(b.origin)) {
      return bad('origin muss ein Kürzel aus a-z, 0-9 und - sein (max. 40 Zeichen)');
    }
    if (b.origin === FEEDBACK_ORIGIN) return bad(`origin „${FEEDBACK_ORIGIN}" ist dem Feedback-Loop vorbehalten`);
    origin = b.origin;
  }

  const hasProperty = b.property !== undefined;
  const hasScope = b.scope !== undefined;
  if (hasProperty === hasScope) return bad('Genau eines von property (Objekt-Slug) oder scope: "alle" angeben');
  let targetFile: string;
  if (hasScope) {
    if (b.scope !== 'alle') return bad('scope kennt nur den Wert "alle"');
    targetFile = ALL_PROPERTIES_TARGET;
  } else {
    if (typeof b.property !== 'string' || !b.property.trim()) return bad('property muss ein Objekt-Slug sein');
    const property = deps.getPropertyBySlug(b.property.trim());
    if (!property) return bad(`Unbekanntes Objekt: ${b.property}`);
    if (!property.vaultNote) return bad(`Objekt ${property.slug} hat keine Vault-Notiz (vaultNote)`);
    targetFile = `prozesse/${property.vaultNote}`;
  }
  if (!isSafeTargetFile(targetFile)) return bad(`Unzulässige Zieldatei: ${targetFile}`);

  const id = deps.newId();
  deps.createOriginSuggestion({
    id, target_file: targetFile, target_heading: heading, addition_text: addition, rationale, origin,
  });
  logger.info({ id, targetFile, heading, origin }, 'Vault-Vorschlag per Agent-API angelegt');
  return { ok: true, suggestion: { id, status: 'pending', target_file: targetFile, target_heading: heading, origin } };
}
