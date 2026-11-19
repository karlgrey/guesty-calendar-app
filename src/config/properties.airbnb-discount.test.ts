// #1243: airbnbDiscount je Objekt — nur Farmhouse hat die Rabatt-Linie; Validierung des Blocks.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getPropertyBySlug, getAllProperties, loadPropertiesConfig, clearPropertiesCache } from './properties.js';

describe('airbnbDiscount in data/properties.json', () => {
  it('nur Farmhouse hat die Rabatt-Linie (7 Tage / Wochenende)', () => {
    expect(getPropertyBySlug('farmhouse')?.airbnbDiscount).toEqual({ shortNoticeDays: 7, weekend: true });
    for (const p of getAllProperties().filter((x) => x.slug !== 'farmhouse')) {
      expect(p.airbnbDiscount).toBeUndefined();
    }
  });
});

describe('airbnbDiscount Validierung', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'props-1243-'));
  const prev = process.env.PROPERTIES_CONFIG_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.PROPERTIES_CONFIG_PATH; else process.env.PROPERTIES_CONFIG_PATH = prev;
    clearPropertiesCache();
  });

  function load(airbnbDiscount: unknown) {
    const file = path.join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({
      properties: [{
        slug: 'x', provider: 'guesty', guestyPropertyId: 'g1', name: 'X',
        bookingRecipientEmail: 'a@b.de', bookingSenderName: 'X',
        weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
        airbnbDiscount,
      }],
    }));
    process.env.PROPERTIES_CONFIG_PATH = file;
    clearPropertiesCache();
    return loadPropertiesConfig();
  }

  it('gültig', () => {
    expect(load({ shortNoticeDays: 3, weekend: false })[0].airbnbDiscount).toEqual({ shortNoticeDays: 3, weekend: false });
  });
  it.each([
    [{ shortNoticeDays: 0, weekend: true }],
    [{ shortNoticeDays: 2.5, weekend: true }],
    [{ shortNoticeDays: 7 }],
    [{ shortNoticeDays: 7, weekend: 'ja' }],
  ])('ungültig %j', (v) => {
    expect(() => load(v)).toThrow();
  });

  it('Aufräumen', () => rmSync(dir, { recursive: true, force: true }));
});
