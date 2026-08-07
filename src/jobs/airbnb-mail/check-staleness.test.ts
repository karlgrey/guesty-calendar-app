// src/jobs/airbnb-mail/check-staleness.test.ts
//
// #327: wires the pure findStaleAirbnbMailSources() to real properties config
// + the DB, and logs an ERROR per stale property so pm2 log-monitoring
// catches it — unlike the existing per-run WARN (which drowned in hourly
// noise and is exactly how Florence's broken sync went unnoticed for 10 weeks).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PropertyConfig } from '../../config/properties.js';

const getPropertiesByProviderMock = vi.fn();
vi.mock('../../config/properties.js', () => ({
  getPropertiesByProvider: (...args: unknown[]) => getPropertiesByProviderMock(...args),
}));

const getLastSyncAtMock = vi.fn();
vi.mock('../../repositories/airbnb-mail-archive-repository.js', () => ({
  getLastSyncAt: (...args: unknown[]) => getLastSyncAtMock(...args),
}));

vi.mock('../../config/index.js', () => ({
  config: { airbnbMailStalenessThresholdHours: 26 },
}));

const errorMock = vi.fn();
vi.mock('../../utils/logger.js', () => ({
  default: { error: (...args: unknown[]) => errorMock(...args) },
}));

import { checkAirbnbMailStaleness } from './check-staleness.js';

const prop = (slug: string, name: string): PropertyConfig =>
  ({ slug, name, provider: 'airbnb-mail' }) as unknown as PropertyConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkAirbnbMailStaleness', () => {
  it('logs an error for each stale airbnb-mail property', () => {
    getPropertiesByProviderMock.mockReturnValue([prop('firenze-loft', 'Florence')]);
    getLastSyncAtMock.mockReturnValue('2026-08-01 00:00:00'); // ancient
    const now = new Date('2026-08-07T12:00:00Z');

    const stale = checkAirbnbMailStaleness(now);

    expect(stale).toHaveLength(1);
    expect(stale[0].slug).toBe('firenze-loft');
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [meta, message] = errorMock.mock.calls[0];
    expect(meta).toMatchObject({ propertySlug: 'firenze-loft' });
    expect(message).toMatch(/stale|Florence/i);
  });

  it('does not log when the property synced recently', () => {
    getPropertiesByProviderMock.mockReturnValue([prop('firenze-loft', 'Florence')]);
    getLastSyncAtMock.mockReturnValue('2026-08-07 11:00:00'); // 1h ago
    const now = new Date('2026-08-07T12:00:00Z');

    const stale = checkAirbnbMailStaleness(now);

    expect(stale).toHaveLength(0);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('only ever looks at airbnb-mail properties (delegates the provider filter)', () => {
    getPropertiesByProviderMock.mockReturnValue([]);
    checkAirbnbMailStaleness(new Date());
    expect(getPropertiesByProviderMock).toHaveBeenCalledWith('airbnb-mail');
    expect(getLastSyncAtMock).not.toHaveBeenCalled();
  });
});
