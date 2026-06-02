import { describe, it, expect } from 'vitest';
import { parseBiReportConfig } from './properties.js';

describe('biReport.forecast config', () => {
  it('defaults forecast to rampMonths 12 / steadyOccupancyPct 0.6 when absent', () => {
    const cfg = parseBiReportConfig({ enabled: true, recipients: ['o@e.com'], day: 1, hour: 6 });
    expect(cfg!.forecast).toEqual({ rampMonths: 12, steadyOccupancyPct: 0.6 });
  });

  it('accepts an explicit forecast block', () => {
    const cfg = parseBiReportConfig({
      enabled: true, recipients: ['o@e.com'], day: 1, hour: 6,
      forecast: { rampMonths: 6, steadyOccupancyPct: 0.7 },
    });
    expect(cfg!.forecast).toEqual({ rampMonths: 6, steadyOccupancyPct: 0.7 });
  });

  it('rejects steadyOccupancyPct above 1', () => {
    expect(() => parseBiReportConfig({
      enabled: true, recipients: ['o@e.com'], day: 1, hour: 6,
      forecast: { steadyOccupancyPct: 1.5 },
    })).toThrow();
  });
});
