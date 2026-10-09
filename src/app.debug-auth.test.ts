// #804: /debug/* (Guesty-Rohdaten, Cache-Dump inkl. quotes_cache) war ohne Auth erreichbar —
// jetzt hinter requireAuth (Admin-Session). Geprüft gegen die echte createApp()-Verdrahtung.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-auth-'));

vi.mock('./config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    getDatabasePath: () => path.join(tmpDir, 'calendar.db'),
  };
});
const getListingMock = vi.fn().mockResolvedValue({ _id: 'x', secret: 'raw-guesty-data' });
vi.mock('./services/guesty-client.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, guestyClient: { ...mod.guestyClient, getListing: (...a: unknown[]) => getListingMock(...a) } };
});
const getDatabaseMock = vi.fn(() => { throw new Error('DB darf ohne Auth nicht angefasst werden'); });
vi.mock('./db/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, getDatabase: () => getDatabaseMock() };
});

import { createApp } from './app.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/debug Auth (#804)', () => {
  for (const p of ['/debug/', '/debug/raw-listing']) {
    it(`GET ${p} ohne Session → kein Zugriff (Redirect auf Login), Handler läuft nicht`, async () => {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/auth/login');
      expect(getListingMock).not.toHaveBeenCalled();
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });
  }

  it('GET /debug/raw-listing mit X-Agent-Key → trotzdem kein Zugriff (nur Session)', async () => {
    const res = await fetch(`${base}/debug/raw-listing`, {
      redirect: 'manual',
      headers: { 'X-Agent-Key': 'irgendein-key-0123456789abcdef0123456789' },
    });
    expect(res.status).toBe(302);
    expect(getListingMock).not.toHaveBeenCalled();
  });
});
