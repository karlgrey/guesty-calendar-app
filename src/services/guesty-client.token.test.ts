// #767-Anteil aus #771 (Vorfall #765, 30.09.2026): Token-Fetch deduplizieren,
// bei 400 invalid_client und langen Retry-After nicht wiederholt anklopfen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuestyClient } from './guesty-client.js';
import { ExternalApiError } from '../utils/errors.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function newClient(): any {
  // Token-Datei-Cache weder lesen noch schreiben (kein data/.guesty-token-cache.json im Test)
  vi.spyOn(GuestyClient.prototype as any, 'loadCachedToken').mockImplementation(() => {});
  vi.spyOn(GuestyClient.prototype as any, 'saveCachedToken').mockImplementation(() => {});
  return new GuestyClient('https://api.example/v1', 'https://auth.example/token', 'cid', 'secret');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GuestyClient.getAccessToken (#767)', () => {
  it('parallele Aufrufer teilen sich EINEN Token-Request', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    const client = newClient();
    const calls = [client.getAccessToken(), client.getAccessToken(), client.getAccessToken()];
    resolve(jsonResponse(200, { access_token: 'tok-1', expires_in: 86400 }));
    expect(await Promise.all(calls)).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // danach aus dem Speicher-Cache, kein weiterer Request
    expect(await client.getAccessToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('nach einem Fehler ist der In-flight-Request freigegeben (nächster Versuch stellt neu an)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-2', expires_in: 86400 }));
    const client = newClient();
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(ExternalApiError);
    expect(await client.getAccessToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('400 invalid_client: kein Retry, weitere Aufrufe scheitern sofort ohne Request', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'invalid_client', error_description: 'Invalid value for client_id parameter' }));
    const client = newClient();
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 400 });
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 503 });
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Sperre nach 400 läuft ab (15 min), dann wird wieder angefragt', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-30T10:00:00Z') });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_client' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-3', expires_in: 86400 }));
    const client = newClient();
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 400 });
    vi.setSystemTime(new Date('2026-09-30T10:16:00Z'));
    expect(await client.getAccessToken()).toBe('tok-3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 mit Retry-After ≈ 16 h: sofort abbrechen statt schlafen, Folgeaufrufe gesperrt', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'rate' }, { 'Retry-After': '57300' }));
    const client = newClient();
    const started = Date.now();
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 429 });
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(client.getAccessToken()).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 mit kurzem Retry-After wird weiterhin abgewartet und wiederholt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate' }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-4', expires_in: 86400 }));
    const client = newClient();
    const p = client.getAccessToken();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe('tok-4');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
