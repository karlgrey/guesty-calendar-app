import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: {
      ...mod.config,
      agentApiKey: 'test-agent-key-0123456789abcdef0123456789',
      agentApiKeySet: ['test-agent-key-0123456789abcdef0123456789'],
    },
  };
});
const getSuggestionsByStatusMock = vi.fn();
vi.mock('../repositories/feedback-repository.js', () => ({
  getSuggestionsByStatus: (...a: unknown[]) => getSuggestionsByStatusMock(...a),
}));
const revokeMock = vi.fn();
vi.mock('../services/vault-suggestion-service.js', () => ({
  revokeVaultSuggestion: (...a: unknown[]) => revokeMock(...a),
}));

import agentApiRoutes from './agent-api.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => { vi.clearAllMocks(); });

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };
const row = {
  id: 's1', feedback_id: 'f1', target_file: 'prozesse/X.md', target_heading: '## A', addition_text: '- x',
  rationale: 'r', status: 'approved', applied_commit: 'abc', applied_at: '2026-11-01 10:00:00',
  revoked_at: null, revoke_commit: null, created_at: '2026-10-31 09:00:00',
};

describe('agent-api #969 vault-suggestions', () => {
  it('401 ohne Key (GET und POST)', async () => {
    expect((await fetch(`${base}/api/agent/vault-suggestions`)).status).toBe(401);
    expect((await fetch(`${base}/api/agent/vault-suggestions/s1/revoke`, { method: 'POST' })).status).toBe(401);
  });

  it('GET ?status=approved -> Liste mit allen Feldern', async () => {
    getSuggestionsByStatusMock.mockReturnValue([row]);
    const r = await fetch(`${base}/api/agent/vault-suggestions?status=approved`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(getSuggestionsByStatusMock).toHaveBeenCalledWith('approved');
    expect(await r.json()).toEqual({ suggestions: [row] });
  });

  it('GET ohne status -> pending', async () => {
    getSuggestionsByStatusMock.mockReturnValue([]);
    await fetch(`${base}/api/agent/vault-suggestions`, { headers: KEY });
    expect(getSuggestionsByStatusMock).toHaveBeenCalledWith('pending');
  });

  it('GET ungültiger status -> 400', async () => {
    const r = await fetch(`${base}/api/agent/vault-suggestions?status=bogus`, { headers: KEY });
    expect(r.status).toBe(400);
    expect(await r.json()).toHaveProperty('error');
    expect(getSuggestionsByStatusMock).not.toHaveBeenCalled();
  });

  it('POST revoke 200', async () => {
    revokeMock.mockReturnValue({ ok: true, suggestion: { ...row, status: 'revoked', revoke_commit: 'def' }, pushed: true, removed: true, alreadyRevoked: false });
    const r = await fetch(`${base}/api/agent/vault-suggestions/s1/revoke`, { method: 'POST', headers: KEY });
    expect(r.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith('s1');
    expect(await r.json()).toEqual({ id: 's1', status: 'revoked', revoke_commit: 'def', removed: true, pushed: true, alreadyRevoked: false });
  });

  it('POST revoke 404 / 409 / 502 als JSON', async () => {
    for (const status of [404, 409, 502]) {
      revokeMock.mockReturnValueOnce({ ok: false, status, error: `e${status}` });
      const r = await fetch(`${base}/api/agent/vault-suggestions/s1/revoke`, { method: 'POST', headers: KEY });
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error: `e${status}` });
    }
  });
});
