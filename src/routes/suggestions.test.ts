import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

const getByStatus = vi.fn();
const getById = vi.fn();
const discardMock = vi.fn();
vi.mock('../repositories/feedback-repository.js', () => ({
  getSuggestionsByStatus: (...a: unknown[]) => getByStatus(...a),
  getSuggestionById: (...a: unknown[]) => getById(...a),
  discardSuggestion: (...a: unknown[]) => discardMock(...a),
}));
const approveMock = vi.fn();
const revokeMock = vi.fn();
vi.mock('../services/vault-suggestion-service.js', () => ({
  approveVaultSuggestion: (...a: unknown[]) => approveMock(...a),
  revokeVaultSuggestion: (...a: unknown[]) => revokeMock(...a),
}));

import suggestionsRoutes from './suggestions.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/admin/suggestions', suggestionsRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => { vi.clearAllMocks(); getByStatus.mockReturnValue([]); });

const s = (over: object) => ({
  id: 's1', feedback_id: 'f', target_file: 'prozesse/X.md', target_heading: '## A', addition_text: '- <b>x</b>',
  rationale: 'r', status: 'approved', applied_commit: 'abcdef1234567', applied_at: '2026-11-01 10:00:00',
  revoked_at: null, revoke_commit: null, ...over,
});

describe('GET /admin/suggestions', () => {
  it('Default pending; ungültiger status -> pending', async () => {
    await fetch(`${base}/admin/suggestions`);
    await fetch(`${base}/admin/suggestions?status=zzz`);
    expect(getByStatus.mock.calls.map((c) => c[0])).toEqual(['pending', 'pending']);
  });

  it('approved: Zurückziehen-Button mit Bestätigung, kurzer Commit, escaped', async () => {
    getByStatus.mockReturnValue([s({})]);
    const html = await (await fetch(`${base}/admin/suggestions?status=approved`)).text();
    expect(getByStatus).toHaveBeenCalledWith('approved');
    expect(html).toContain('/admin/suggestions/s1/revoke');
    expect(html).toContain('Zurückziehen');
    expect(html).toContain('confirm(');
    expect(html).toContain('abcdef1');
    expect(html).not.toContain('abcdef1234567');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('revoked: Erneut-freigeben-Button (approve) und Revoke-Infos', async () => {
    getByStatus.mockReturnValue([s({ status: 'revoked', revoked_at: '2026-11-02 08:00:00', revoke_commit: '9999999aaa' })]);
    const html = await (await fetch(`${base}/admin/suggestions?status=revoked`)).text();
    expect(html).toContain('Erneut freigeben');
    expect(html).toContain('/admin/suggestions/s1/approve');
    expect(html).toContain('9999999');
    expect(html).not.toContain('/revoke"');
  });
});

describe('POST /admin/suggestions/:id/revoke', () => {
  it('Redirect auf approved-Liste; push=pending wenn nicht gepusht', async () => {
    revokeMock.mockReturnValueOnce({ ok: true, pushed: true });
    let r = await fetch(`${base}/admin/suggestions/s1/revoke`, { method: 'POST', redirect: 'manual' });
    expect(r.headers.get('location')).toBe('/admin/suggestions?status=approved');
    revokeMock.mockReturnValueOnce({ ok: true, pushed: false });
    r = await fetch(`${base}/admin/suggestions/s1/revoke`, { method: 'POST', redirect: 'manual' });
    expect(r.headers.get('location')).toBe('/admin/suggestions?status=approved&push=pending');
  });
  it('404/409/502 durchgereicht', async () => {
    revokeMock.mockReturnValueOnce({ ok: false, status: 409, error: 'nope' });
    const r = await fetch(`${base}/admin/suggestions/s1/revoke`, { method: 'POST', redirect: 'manual' });
    expect(r.status).toBe(409);
  });
});

describe('POST /admin/suggestions/:id/discard', () => {
  const post = () => fetch(`${base}/admin/suggestions/s1/discard`, { method: 'POST', redirect: 'manual' });

  it('pending: verwirft und leitet auf die Liste um', async () => {
    getById.mockReturnValue(s({ status: 'pending' }));
    const r = await post();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/suggestions');
    expect(discardMock).toHaveBeenCalledWith('s1');
  });

  it.each(['approved', 'revoked', 'discarded'])('%s: 409, nicht verworfen, Hinweis auf Revoke', async (status) => {
    getById.mockReturnValue(s({ status }));
    const r = await post();
    expect(r.status).toBe(409);
    const body = await r.text();
    expect(body).toContain('Nur offene Vorschläge');
    expect(body).toContain(`Status: ${status}`);
    expect(body).toContain('/admin/suggestions/s1/revoke');
    expect(discardMock).not.toHaveBeenCalled();
  });

  it('unbekannt: 404', async () => {
    getById.mockReturnValue(undefined);
    expect((await post()).status).toBe(404);
    expect(discardMock).not.toHaveBeenCalled();
  });
});
