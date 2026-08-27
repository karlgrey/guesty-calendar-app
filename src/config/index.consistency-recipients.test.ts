import { describe, it, expect, afterEach, vi } from 'vitest';

// F7: CONSISTENCY_ALERT_RECIPIENTS muss leere Einträge (führendes/doppeltes/
// nachgestelltes Komma) verwerfen, nicht nur trimmen — sonst landet ein
// leerer String als "Empfänger" in der Mail-Adressliste.
describe('config: consistencyAlertRecipients (F7)', () => {
  const originalEnv = process.env.CONSISTENCY_ALERT_RECIPIENTS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CONSISTENCY_ALERT_RECIPIENTS;
    else process.env.CONSISTENCY_ALERT_RECIPIENTS = originalEnv;
    vi.resetModules();
  });

  it('trimmt und verwirft leere Einträge', async () => {
    process.env.CONSISTENCY_ALERT_RECIPIENTS = ' a@example.com, ,b@example.com,,c@example.com ,';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.consistencyAlertRecipients).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('leerer String -> leeres Array', async () => {
    process.env.CONSISTENCY_ALERT_RECIPIENTS = '';
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.consistencyAlertRecipients).toEqual([]);
  });

  it('unset -> leeres Array', async () => {
    delete process.env.CONSISTENCY_ALERT_RECIPIENTS;
    vi.resetModules();
    const { config } = await import('./index.js');
    expect(config.consistencyAlertRecipients).toEqual([]);
  });
});
