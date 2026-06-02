import { describe, it, expect } from 'vitest';
import { parseBiReportConfig } from './properties.js';

describe('parseBiReportConfig', () => {
  it('parses a full valid block', () => {
    const cfg = parseBiReportConfig({
      enabled: true,
      recipients: ['owner@example.com'],
      day: 1,
      hour: 6,
      timezone: 'Europe/Berlin',
      forecastHorizonMonths: 6,
    });
    expect(cfg).toEqual({
      enabled: true,
      recipients: ['owner@example.com'],
      day: 1,
      hour: 6,
      timezone: 'Europe/Berlin',
      forecastHorizonMonths: 6,
    });
  });

  it('applies defaults for timezone and horizon', () => {
    const cfg = parseBiReportConfig({ enabled: true, recipients: ['o@e.com'], day: 1, hour: 6 });
    expect(cfg.timezone).toBe('Europe/Berlin');
    expect(cfg.forecastHorizonMonths).toBe(6);
  });

  it('returns undefined when block is absent', () => {
    expect(parseBiReportConfig(undefined)).toBeUndefined();
  });

  it('throws on invalid email', () => {
    expect(() => parseBiReportConfig({ enabled: true, recipients: ['nope'], day: 1, hour: 6 })).toThrow();
  });
});
