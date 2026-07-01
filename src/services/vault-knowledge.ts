import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const HOSTING_DIR = 'Areas/Hosting';
const SAFE_NOTE = /^[A-Za-z0-9._-]+\.md$/;

function readVaultFile(relPath: string, baseDir: string | undefined): string | null {
  if (!baseDir) return null;
  try {
    return readFileSync(join(baseDir, relPath), 'utf8');
  } catch {
    logger.debug({ relPath }, 'vault-knowledge: file not readable (skipping)');
    return null;
  }
}

export function loadVoice(baseDir: string | undefined = config.vaultPath): string | null {
  return readVaultFile(join(HOSTING_DIR, '_Voice.md'), baseDir);
}

export function loadPropertyFacts(
  vaultNote: string,
  baseDir: string | undefined = config.vaultPath,
): string | null {
  if (!SAFE_NOTE.test(vaultNote)) {
    logger.warn({ vaultNote }, 'vault-knowledge: unsafe vaultNote rejected');
    return null;
  }
  return readVaultFile(join(HOSTING_DIR, 'Properties', vaultNote), baseDir);
}
