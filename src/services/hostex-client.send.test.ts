import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostexClient } from './hostex-client.js';
import logger from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';

function stubFetch(data: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ request_id: 'r', error_code: 200, error_msg: 'ok', data }),
  }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('HostexClient.sendMessage (#974)', () => {
  it('liest message_id', async () => {
    stubFetch({ message_id: 'm-1' });
    const c = new HostexClient('tok', 'https://example.test/v3');
    expect(await c.sendMessage('c1', 'Hallo')).toEqual({ message_id: 'm-1' });
  });
  it('fällt auf id zurück und stringifiziert', async () => {
    stubFetch({ id: 42 });
    const c = new HostexClient('tok', 'https://example.test/v3');
    expect(await c.sendMessage('c1', 'Hallo')).toEqual({ message_id: '42' });
  });
  it('leere Antwort → leere ID + Warnung, Antwort geloggt ohne Nachrichtentext', async () => {
    stubFetch({});
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    const c = new HostexClient('tok', 'https://example.test/v3');
    expect(await c.sendMessage('c1', 'Geheimer Text')).toEqual({ message_id: '' });
    expect(info).toHaveBeenCalledWith(
      { conversationId: 'c1', response: JSON.stringify({ request_id: 'r', error_code: 200, error_msg: 'ok', data: {} }) },
      'Hostex sendMessage response',
    );
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('Geheimer Text');
  });
  it('echte Hostex-Antwort laut Doku (nur Envelope, kein data) → leere ID, Envelope geloggt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ request_id: 'req-anon', error_code: 200, error_msg: 'Done.' }),
    }));
    const info = vi.spyOn(logger, 'info');
    const c = new HostexClient('tok', 'https://example.test/v3');
    expect(await c.sendMessage('c1', 'Hallo')).toEqual({ message_id: '' });
    expect(info).toHaveBeenCalledWith(
      { conversationId: 'c1', response: '{"request_id":"req-anon","error_code":200,"error_msg":"Done."}' },
      'Hostex sendMessage response',
    );
  });
  it('verschachtelte Pfade in fester Reihenfolge', async () => {
    const c = new HostexClient('tok', 'https://example.test/v3');
    stubFetch({ message: { id: 'n-1' } });
    expect((await c.sendMessage('c1', 'x')).message_id).toBe('n-1');
    stubFetch({ data: { message_id: 7 } });
    expect((await c.sendMessage('c1', 'x')).message_id).toBe('7');
    stubFetch({ message_id: 'a', id: 'b', message: { id: 'c' } });
    expect((await c.sendMessage('c1', 'x')).message_id).toBe('a');
    stubFetch({ data: { message_id: 'dd-1' } });
    expect((await c.sendMessage('c1', 'x')).message_id).toBe('dd-1');
  });
  it('error_code ≠ 200 wirft ExternalApiError (Fehlerpfad von call/callEnvelope unverändert)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ request_id: 'req-x', error_code: 422, error_msg: 'invalid' }),
    }));
    const c = new HostexClient('tok', 'https://example.test/v3');
    await expect(c.sendMessage('c1', 'x')).rejects.toBeInstanceOf(ExternalApiError);
    await expect(c.getProperties()).rejects.toThrow('Hostex 422: invalid (request_id=req-x)');
  });
  it('kürzt die geloggte Antwort auf 500 Zeichen', async () => {
    stubFetch({ blob: 'x'.repeat(2000) });
    const info = vi.spyOn(logger, 'info');
    const c = new HostexClient('tok', 'https://example.test/v3');
    await c.sendMessage('c1', 'x');
    const logged = (info.mock.calls.find((x) => x[1] === 'Hostex sendMessage response')![0] as any).response;
    expect(logged.length).toBe(500);
  });
});
