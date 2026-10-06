// #772 Telemetrie: Zähler je Kategorie, Retries und 429 im guestyClient.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuestyClient, categorizeGuestyEndpoint, diffRequestCounters, emptyRequestCounters } from './guesty-client.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;
function newClient(): any {
  vi.spyOn(GuestyClient.prototype as any, 'loadCachedToken').mockImplementation(() => {});
  vi.spyOn(GuestyClient.prototype as any, 'saveCachedToken').mockImplementation(() => {});
  const c: any = new GuestyClient('https://api.example/v1', 'https://auth.example/token', 'cid', 'secret');
  c.accessToken = 'tok';
  c.tokenExpiresAt = Date.now() + 24 * 3600 * 1000;
  return c;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('categorizeGuestyEndpoint', () => {
  it('ordnet Konversations-Endpunkte zu', () => {
    expect(categorizeGuestyEndpoint('/communication/conversations?limit=100')).toBe('conversationList');
    expect(categorizeGuestyEndpoint('/communication/conversations/abc/posts?limit=200')).toBe('conversationPosts');
    expect(categorizeGuestyEndpoint('/communication/conversations/abc')).toBe('conversationGet');
    expect(categorizeGuestyEndpoint('/communication/conversations/abc/send-message')).toBe('other');
    expect(categorizeGuestyEndpoint('/listings/123')).toBe('other');
  });
});

describe('GuestyClient Request-Zähler', () => {
  it('zählt jeden Versuch, Retries und 429', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // Jitter 0
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { conversations: [{ _id: 'a' }], cursor: { after: '' } } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { posts: [] } }));
    const client = newClient();
    const before = client.getRequestCounters();
    await client.listConversations({ limit: 100 });
    await client.listConversationPosts('a', 200);
    const d = diffRequestCounters(client.getRequestCounters(), before);
    expect(d).toEqual({ ...emptyRequestCounters(), total: 3, conversationList: 2, conversationPosts: 1, retries: 1, rateLimited429: 1 });
  });

  it('getRequestCounters liefert eine Kopie', () => {
    const client = newClient();
    const snap = client.getRequestCounters();
    snap.total = 99;
    expect(client.getRequestCounters().total).toBe(0);
  });
});
