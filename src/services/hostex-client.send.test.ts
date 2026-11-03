import { describe, it, expect, vi, afterEach } from 'vitest';
import { HostexClient } from './hostex-client.js';
import logger from '../utils/logger.js';

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
    expect(info).toHaveBeenCalledWith({ conversationId: 'c1', response: {} }, 'Hostex sendMessage response');
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('Geheimer Text');
  });
});
