// #1169: METER_INGEST_TOKEN darf den App-Start nie verhindern — ein zu kurzer Wert wird
// durchgereicht und schaltet erst in routes/meter-ingest.ts den Endpunkt ab (503).
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('config.meterIngestToken', () => {
  const original = process.env.METER_INGEST_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.METER_INGEST_TOKEN;
    else process.env.METER_INGEST_TOKEN = original;
    vi.resetModules();
  });

  it('zu kurzer Wert -> Konfiguration lädt trotzdem (kein Abbruch beim Start)', async () => {
    process.env.METER_INGEST_TOKEN = 'zu-kurz';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.meterIngestToken).toBe('zu-kurz');
  });

  it('leer oder nur Leerzeichen -> undefined (Endpunkt 503)', async () => {
    process.env.METER_INGEST_TOKEN = '   ';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.meterIngestToken).toBeUndefined();
  });

  it('Wert wird getrimmt', async () => {
    process.env.METER_INGEST_TOKEN = `  ${'t'.repeat(40)}  `;
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.meterIngestToken).toBe('t'.repeat(40));
  });
});
