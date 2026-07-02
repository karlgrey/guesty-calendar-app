// src/services/vault-writer.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { config } from '../config/index.js';
import type { VaultSuggestion } from '../types/feedback.js';

const SAFE_TARGET = /^Areas\/Hosting\/[A-Za-z0-9._/-]+\.md$/;

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
  try {
    deps.writeFile(abs, insertUnderHeading(content, s.target_heading, s.addition_text));
  } catch (err) {
    return { committed: false, commit: null, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    deps.git(['add', s.target_file]);
    deps.git(['commit', '-m', `Vault-Update via Feedback-Loop (${s.target_heading})`]);
    const commit = deps.git(['rev-parse', 'HEAD']).trim();
    return { committed: true, commit };
  } catch (err) {
    return { committed: false, commit: null, error: `git failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
