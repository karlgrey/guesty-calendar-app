// src/services/airbnb-mail-staleness.test.ts
//
// #327: staleness alarm for the airbnb-mail sync channel. #324 fixed the
// WEDGE (one bad mail permanently stuck a property's UID progress); this
// closes the remaining gap — a sync that silently stops working (e.g. broken
// IMAP login) without wedging anything, so nothing flags that no successful
// poll happened in a long time (Florence stood still, unnoticed, ~10 weeks).
import { describe, it, expect } from 'vitest';
import { findStaleAirbnbMailSources, DEFAULT_STALENESS_THRESHOLD_HOURS } from './airbnb-mail-staleness.js';
import type { PropertyConfig } from '../config/properties.js';

const airbnbMailProp = (slug: string, name: string): Pick<PropertyConfig, 'slug' | 'name' | 'provider'> => ({
  slug,
  name,
  provider: 'airbnb-mail',
});

const guestyProp = (slug: string, name: string): Pick<PropertyConfig, 'slug' | 'name' | 'provider'> => ({
  slug,
  name,
  provider: 'guesty',
});

describe('findStaleAirbnbMailSources', () => {
  it('does not flag a property synced well within the threshold', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const lastSyncAtBySlug = new Map([['firenze-loft', '2026-08-07 10:00:00']]); // 2h ago
    const stale = findStaleAirbnbMailSources([airbnbMailProp('firenze-loft', 'Florence')], lastSyncAtBySlug, now);
    expect(stale).toEqual([]);
  });

  it('flags a property whose last sync is older than the threshold', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    // 30h ago — past the 26h default
    const lastSyncAtBySlug = new Map([['firenze-loft', '2026-08-06 06:00:00']]);
    const stale = findStaleAirbnbMailSources([airbnbMailProp('firenze-loft', 'Florence')], lastSyncAtBySlug, now);
    expect(stale).toEqual([{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: 30 }]);
  });

  it('ignores properties without an airbnb-mail channel entirely, even if flagged stale in the lookup', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const lastSyncAtBySlug = new Map([['farmhouse', '2026-01-01 00:00:00']]); // ancient, but irrelevant
    const stale = findStaleAirbnbMailSources([guestyProp('farmhouse', 'Farmhouse')], lastSyncAtBySlug, now);
    expect(stale).toEqual([]);
  });

  it('flags a property that has never synced at all (no state row)', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const stale = findStaleAirbnbMailSources([airbnbMailProp('firenze-loft', 'Florence')], new Map(), now);
    expect(stale).toEqual([{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: null }]);
  });

  it('respects a custom threshold', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const lastSyncAtBySlug = new Map([['firenze-loft', '2026-08-07T10:00:00Z']]); // 2h ago
    const stale = findStaleAirbnbMailSources([airbnbMailProp('firenze-loft', 'Florence')], lastSyncAtBySlug, now, 1);
    expect(stale).toEqual([{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: 2 }]);
  });

  it('is exact at the threshold boundary (>=, not >)', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const lastSyncAtBySlug = new Map([['firenze-loft', '2026-08-06 10:00:00']]); // exactly 26h ago
    const stale = findStaleAirbnbMailSources(
      [airbnbMailProp('firenze-loft', 'Florence')],
      lastSyncAtBySlug,
      now,
      DEFAULT_STALENESS_THRESHOLD_HOURS
    );
    expect(stale).toEqual([{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: 26 }]);
  });

  it('correctly treats the bare SQLite datetime string as UTC (not local time)', () => {
    // If parsed as local time on a machine east of UTC, this would (wrongly)
    // look further in the past than it is, and could over- or under-flag.
    const now = new Date('2026-08-07T12:00:00Z');
    const lastSyncAtBySlug = new Map([['firenze-loft', '2026-08-07 11:00:00']]); // 1h ago, UTC
    const stale = findStaleAirbnbMailSources([airbnbMailProp('firenze-loft', 'Florence')], lastSyncAtBySlug, now, 26);
    expect(stale).toEqual([]);
  });
});
