import { describe, it, expect, afterEach, vi } from 'vitest';

// dotenv gemockt: eine lokale .env mit HOST=… darf den Default-Test nicht beeinflussen.
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));

// #879: Caddy ist der einzige öffentliche Eingang — ohne HOST lauscht der Server nur auf Loopback.
describe('config: host-Default (#879)', () => {
  const originalHost = process.env.HOST;

  afterEach(() => {
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
    vi.resetModules();
  });

  it('HOST nicht gesetzt -> 127.0.0.1', async () => {
    delete process.env.HOST;
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.host).toBe('127.0.0.1');
  });

  it('HOST=0.0.0.0 -> Override bleibt möglich', async () => {
    process.env.HOST = '0.0.0.0';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.host).toBe('0.0.0.0');
  });
});
