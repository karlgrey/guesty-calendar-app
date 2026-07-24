import { describe, it, expect, vi, beforeEach } from 'vitest';

// config mocken, damit wir den Key pro Test steuern können
vi.mock('../config/index.js', () => ({ config: { agentApiKey: undefined as string | undefined } }));

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
  beforeEach(() => { (config as any).agentApiKey = undefined; });

  it('503 wenn kein Key konfiguriert', () => {
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 bei fehlendem Header', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: () => undefined } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('401 bei falschem Key', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'wrong' : undefined) } as any, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('next() bei korrektem Key', () => {
    (config as any).agentApiKey = 'secret-key-123';
    const res = mockRes(); const next = vi.fn();
    requireAgentKey({ header: (n: string) => (n === 'X-Agent-Key' ? 'secret-key-123' : undefined) } as any, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
