import { describe, it, expect, afterEach, vi } from 'vitest';

// #671: AGENT_API_KEYS (kommagetrennt, Whitespace-tolerant) ergänzt den bestehenden
// Einzelwert AGENT_API_KEY — Vereinigungsmenge in config.agentApiKeySet, die einzige
// Quelle, die die Agent-Key-Middleware konsultiert.
describe('config: agentApiKeySet (#671)', () => {
  const originalKey = process.env.AGENT_API_KEY;
  const originalKeys = process.env.AGENT_API_KEYS;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = originalKey;
    if (originalKeys === undefined) delete process.env.AGENT_API_KEYS;
    else process.env.AGENT_API_KEYS = originalKeys;
    vi.resetModules();
  });

  it('unset -> leeres Array (Agent-API deaktiviert)', async () => {
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_API_KEYS;
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.agentApiKeySet).toEqual([]);
  });

  it('nur AGENT_API_KEY (Einzelkonfiguration, abwärtskompatibel)', async () => {
    process.env.AGENT_API_KEY = 'single-key-1234567890123456789012345';
    delete process.env.AGENT_API_KEYS;
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.agentApiKeySet).toEqual(['single-key-1234567890123456789012345']);
  });

  it('nur AGENT_API_KEYS (Liste, Whitespace toleriert)', async () => {
    delete process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEYS = ' key-one-1234567890123456789012345 , key-two-1234567890123456789012345 ';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.agentApiKeySet).toEqual([
      'key-one-1234567890123456789012345',
      'key-two-1234567890123456789012345',
    ]);
  });

  it('Mischkonfiguration: AGENT_API_KEY + AGENT_API_KEYS, dedupliziert', async () => {
    process.env.AGENT_API_KEY = 'shared-key-123456789012345678901234';
    process.env.AGENT_API_KEYS = 'shared-key-123456789012345678901234,extra-key-12345678901234567890123';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.agentApiKeySet).toEqual([
      'shared-key-123456789012345678901234',
      'extra-key-12345678901234567890123',
    ]);
  });

  it('leere Einträge (führendes/doppeltes Komma) werden verworfen', async () => {
    delete process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEYS = ',key-one-1234567890123456789012345,,key-two-1234567890123456789012345,';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.agentApiKeySet).toEqual([
      'key-one-1234567890123456789012345',
      'key-two-1234567890123456789012345',
    ]);
  });

  it('Eintrag unter 32 Zeichen in AGENT_API_KEYS lässt die Config-Validierung fehlschlagen', async () => {
    delete process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEYS = 'zu-kurz';
    vi.resetModules();
    await expect(import('./index.js')).rejects.toThrow();
  });
});
