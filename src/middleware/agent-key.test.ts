import { describe, it, expect, vi, beforeEach } from 'vitest';

// config mocken, damit wir die gültigen Keys pro Test steuern können
vi.mock('../config/index.js', () => ({ config: { agentApiKeySet: [] as string[] } }));

// logger mocken, sonst schlägt die Pino-Initialisierung fehl (config.logLevel ist im Mock undefined)
vi.mock('../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { config } from '../config/index.js';
import { requireAgentKey } from './agent-key.js';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('requireAgentKey', () => {
  beforeEach(() => { (config as any).agentApiKeySet = []; });

  it('503 wenn keine Keys konfiguriert', () => {
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 bei fehlendem Header', () => {
    (config as any).agentApiKeySet = ['secret-key-123456789012345678901234'];
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('401 bei falschem Key', () => {
    (config as any).agentApiKeySet = ['secret-key-123456789012345678901234'];
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'wrong' : undefined) } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('next() bei korrektem Key (Einzelkonfiguration)', () => {
    (config as any).agentApiKeySet = ['secret-key-123456789012345678901234'];
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'secret-key-123456789012345678901234' : undefined) } as any, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('next() bei korrektem Key aus einer Liste mehrerer Keys', () => {
    (config as any).agentApiKeySet = [
      'first-key-1234567890123456789012345',
      'second-key-123456789012345678901234',
      'third-key-1234567890123456789012345',
    ];
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'second-key-123456789012345678901234' : undefined) } as any, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('401 bei falschem Key trotz konfigurierter Liste (Mischkonfiguration)', () => {
    (config as any).agentApiKeySet = [
      'first-key-1234567890123456789012345',
      'second-key-123456789012345678901234',
    ];
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'not-in-the-list-0000000000000000000' : undefined) } as any, res, next);
    expect(res.statusCode).toBe(401);
  });
});
