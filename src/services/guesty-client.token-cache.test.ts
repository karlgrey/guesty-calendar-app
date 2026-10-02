// #767: Token-Cache-Datei (Guesty-Bearer) nur für den App-User lesbar — 0600 beim
// Schreiben, Altbestand (644, Vorfall #765) wird beim Laden nachgezogen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GuestyClient } from './guesty-client.js';

let dir: string;
const cachePath = () => path.join(dir, 'data', '.guesty-token-cache.json');
const newClient = (): any =>
  new GuestyClient('https://api.example/v1', 'https://auth.example/token', 'cid', 'secret');
const mode = () => fs.statSync(cachePath()).mode & 0o777;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-token-cache-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Token-Cache-Dateirechte (#767)', () => {
  it('legt die Cache-Datei mit 0600 an', () => {
    const client = newClient();
    client.accessToken = 'tok';
    client.tokenExpiresAt = Date.now() + 3600_000;
    client.saveCachedToken();
    expect(mode()).toBe(0o600);
  });

  it('zieht eine bestehende 644-Datei beim Überschreiben auf 0600', () => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(cachePath(), '{}');
    fs.chmodSync(cachePath(), 0o644);
    const client = newClient(); // lädt: "{}" hat kein expiresAt → Datei wird gelöscht
    fs.writeFileSync(cachePath(), '{}');
    fs.chmodSync(cachePath(), 0o644);
    client.accessToken = 'tok';
    client.tokenExpiresAt = Date.now() + 3600_000;
    client.saveCachedToken();
    expect(mode()).toBe(0o600);
  });

  it('zieht eine gültige 644-Datei schon beim Laden auf 0600', () => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ accessToken: 'alt', expiresAt: Date.now() + 3600_000 }));
    fs.chmodSync(cachePath(), 0o644);
    const client = newClient();
    expect(client.accessToken).toBe('alt');
    expect(mode()).toBe(0o600);
  });
});
