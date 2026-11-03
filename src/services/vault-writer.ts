// src/services/vault-writer.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { config } from '../config/index.js';
import type { VaultSuggestion } from '../types/feedback.js';

const SAFE_TARGET = /^prozesse\/[\p{L}\p{N} ._-]+\.md$/u;

export interface VaultWriterDeps {
  vaultPath: string | undefined;
  readFile: (p: string) => string;
  writeFile: (p: string, c: string) => void;
  git: (args: string[]) => string;
}

function defaultDeps(): VaultWriterDeps {
  const vaultPath = config.vaultPath;
  return {
    vaultPath,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c),
    git: (args) => String(execFileSync('git', ['-C', vaultPath as string, ...args])),
  };
}

/** Insert `addition` at the end of the section under `heading` (before the next `## `, else EOF). */
export function insertUnderHeading(content: string, heading: string, addition: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading.trim());
  if (idx === -1) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n${heading}\n${addition}\n`;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, addition);
  return lines.join('\n');
}

/**
 * Entfernt den ERSTEN zusammenhängenden Block aus dem Abschnitt unter `heading`, dessen Zeilen
 * (trim-verglichen) exakt `addition` (zeilenweise, getrimmt) entsprechen. Nur diese Zeilen —
 * keine Leerzeilen drumherum, nichts außerhalb des Abschnitts. Nicht gefunden → removed:false.
 */
export function removeUnderHeading(
  content: string, heading: string, addition: string,
): { content: string; removed: boolean } {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading.trim());
  if (idx === -1) return { content, removed: false };
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const target = addition.trim().split('\n').map((l) => l.trim());
  if (target.length === 0 || (target.length === 1 && target[0] === '')) return { content, removed: false };
  for (let i = idx + 1; i + target.length <= end; i++) {
    if (target.every((t, k) => lines[i + k].trim() === t)) {
      lines.splice(i, target.length);
      return { content: lines.join('\n'), removed: true };
    }
  }
  return { content, removed: false };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** true, wenn `file` im Index Änderungen gegenüber HEAD hat (nach `git add`). */
function hasStagedChanges(deps: VaultWriterDeps, file: string): boolean {
  return deps.git(['status', '--porcelain', '--', file]).trim() !== '';
}

export function applySuggestion(
  s: VaultSuggestion,
  deps: VaultWriterDeps = defaultDeps(),
): { committed: boolean; commit: string | null; error?: string } {
  if (!SAFE_TARGET.test(s.target_file) || s.target_file.includes('..')) {
    return { committed: false, commit: null, error: 'unsafe target_file' };
  }
  if (!deps.vaultPath) return { committed: false, commit: null, error: 'VAULT_PATH not set' };

  const abs = join(deps.vaultPath, s.target_file);
  let content: string;
  try {
    content = deps.readFile(abs);
  } catch (err) {
    return { committed: false, commit: null, error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const trimmedAddition = s.addition_text.trim();
  if (!content.includes(trimmedAddition)) {
    try {
      deps.writeFile(abs, insertUnderHeading(content, s.target_heading, s.addition_text));
    } catch (err) {
      return { committed: false, commit: null, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  try {
    deps.git(['add', s.target_file]);
    // Idempotenz: Zeile war schon da -> nichts zu committen (kein "nothing to commit"-Fehler).
    if (!hasStagedChanges(deps, s.target_file)) return { committed: false, commit: null };
    deps.git(['commit', '-m', `Vault-Update via Feedback-Loop (${s.target_heading})`]);
    const commit = deps.git(['rev-parse', 'HEAD']).trim();
    return { committed: true, commit };
  } catch (err) {
    return { committed: false, commit: null, error: `git failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Nimmt eine freigegebene Ergänzung zurück: entfernt genau die addition_text-Zeile(n) unter der
 * Überschrift und committet mit "Vault-Update zurückgezogen (<heading>)" — TheBrain2/tools/sync.py
 * erkennt Revoke-Commits an diesem Präfix. Zeile schon weg → idempotent: kein Write, kein Commit.
 */
export function revokeSuggestion(
  s: VaultSuggestion,
  deps: VaultWriterDeps = defaultDeps(),
): { committed: boolean; commit: string | null; removed: boolean; error?: string } {
  if (!SAFE_TARGET.test(s.target_file) || s.target_file.includes('..')) {
    return { committed: false, commit: null, removed: false, error: 'unsafe target_file' };
  }
  if (!deps.vaultPath) return { committed: false, commit: null, removed: false, error: 'VAULT_PATH not set' };

  const abs = join(deps.vaultPath, s.target_file);
  let content: string;
  try {
    content = deps.readFile(abs);
  } catch (err) {
    return { committed: false, commit: null, removed: false, error: `read failed: ${errMsg(err)}` };
  }
  const res = removeUnderHeading(content, s.target_heading, s.addition_text);
  if (!res.removed) return { committed: false, commit: null, removed: false };

  try {
    deps.writeFile(abs, res.content);
  } catch (err) {
    return { committed: false, commit: null, removed: false, error: `write failed: ${errMsg(err)}` };
  }
  try {
    deps.git(['add', s.target_file]);
    deps.git(['commit', '-m', `Vault-Update zurückgezogen (${s.target_heading})`]);
    const commit = deps.git(['rev-parse', 'HEAD']).trim();
    return { committed: true, commit, removed: true };
  } catch (err) {
    return { committed: false, commit: null, removed: true, error: `git failed: ${errMsg(err)}` };
  }
}
