import { describe, it, expect, vi, afterEach } from 'vitest';
import { SmartTasksClient } from './smarttasks-client.js';

const originalFetch = global.fetch;

describe('SmartTasksClient', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('wirft ohne API-Key', () => {
    expect(() => new SmartTasksClient(undefined, 'https://tasks.example.com/api')).toThrow(/SMARTTASKS_API_KEY/);
  });

  it('POST /tasks mit Bearer-Auth, gibt die Task-Id zurück', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 742 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SmartTasksClient('a-real-key', 'https://tasks.example.com/api');
    const result = await client.createTask({ title: 'Zusage an Gast Lorenzo (U19): X', projectId: 36, assigneeId: 1 });
    expect(result).toEqual({ id: 742 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tasks.example.com/api/tasks');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer a-real-key');
    expect(JSON.parse(opts.body)).toMatchObject({ title: 'Zusage an Gast Lorenzo (U19): X', projectId: 36, assigneeId: 1 });
  });

  it('HTTP-Fehler (z. B. 401/500) → wirft ExternalApiError mit Statuscode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SmartTasksClient('k', 'https://tasks.example.com/api');
    await expect(client.createTask({ title: 'x' })).rejects.toMatchObject({ statusCode: 500 });
  });

  it('Antwort ohne id → wirft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SmartTasksClient('k', 'https://tasks.example.com/api');
    await expect(client.createTask({ title: 'x' })).rejects.toThrow(/ohne Task-Id/);
  });

  it('Netzwerkfehler → wirft ExternalApiError statt zu crashen', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SmartTasksClient('k', 'https://tasks.example.com/api');
    await expect(client.createTask({ title: 'x' })).rejects.toThrow(/SmartTasks-Aufruf fehlgeschlagen/);
  });

  it('Timeout (AbortController) → wirft ExternalApiError, kein Crash', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new SmartTasksClient('k', 'https://tasks.example.com/api');
    await expect(client.createTask({ title: 'x' })).rejects.toThrow(/Timeout/);
  });
});
