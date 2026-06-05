import { describe, it, expect } from 'vitest';
import { buildBlockSpans, buildBlockEvent, blockEventId, blockLabel } from './google-calendar-blocks.js';

describe('buildBlockSpans', () => {
  it('groups consecutive blocked days into spans (end exclusive)', () => {
    const spans = buildBlockSpans([
      { date: '2026-06-04', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-05', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-06', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-07', status: 'available', block_type: null },
      { date: '2026-06-08', status: 'blocked', block_type: null },
    ]);
    expect(spans).toEqual([
      { startDate: '2026-06-04', endExclusive: '2026-06-07', blockType: 'owner' },
      { startDate: '2026-06-08', endExclusive: '2026-06-09', blockType: null },
    ]);
  });

  it('ignores booked/available; empty input -> []', () => {
    expect(buildBlockSpans([{ date: '2026-06-04', status: 'booked', block_type: 'reservation' }])).toEqual([]);
    expect(buildBlockSpans([])).toEqual([]);
  });

  it('splits spans when block_type changes on consecutive days', () => {
    const spans = buildBlockSpans([
      { date: '2026-06-04', status: 'blocked', block_type: 'owner' },
      { date: '2026-06-05', status: 'blocked', block_type: 'manual' },
    ]);
    expect(spans).toEqual([
      { startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'owner' },
      { startDate: '2026-06-05', endExclusive: '2026-06-06', blockType: 'manual' },
    ]);
  });
});

describe('blockLabel', () => {
  it('labels by reason, falls back to provider, no lock emoji', () => {
    expect(blockLabel('owner', 'guesty')).toBe('Owner-Block');
    expect(blockLabel('maintenance', 'guesty')).toBe('Wartung');
    expect(blockLabel('manual', 'guesty')).toBe('Manuell blockiert');
    expect(blockLabel(null, 'hostex')).toBe('Blockiert (Hostex)');
    expect(blockLabel(null, 'airbnb-mail')).toBe('Blockiert (Airbnb)');
    expect(blockLabel(null, 'guesty')).toBe('Blockiert');
    expect(blockLabel('owner', 'guesty')).not.toContain('🔒');
  });
});

describe('buildBlockEvent', () => {
  it('titles by reason (no lock emoji), with context description + cleanup marker', () => {
    const ev = buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-08', blockType: 'owner' }, 'Bootshaus', 'hostex');
    expect(ev.summary).toBe('Owner-Block');           // reason wins over provider
    expect(ev.summary).not.toContain('🔒');
    expect(ev.start).toEqual({ date: '2026-06-04' });
    expect(ev.end).toEqual({ date: '2026-06-08' });
    expect(ev.location).toBe('Bootshaus');
    expect(ev.transparency).toBe('opaque');
    expect(ev.extendedProperties?.private?.kind).toBe('owner-block');
    expect(ev.description).toContain('Quelle: Hostex');
    expect(ev.description).toContain('4 Nächte');
    expect(ev.description).toContain('04.06.');
    expect(ev.description).toContain('08.06.');
  });

  it('falls back to provider-based title when block_type is null; pluralises 1 Nacht', () => {
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X', 'hostex').summary).toBe('Blockiert (Hostex)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'manual' }, 'X', 'guesty').summary).toBe('Manuell blockiert');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X', 'guesty').description).toContain('1 Nacht');
  });
});

describe('blockEventId', () => {
  it('is stable and namespaced', () => {
    expect(blockEventId('12659677', '2026-06-04')).toBe(blockEventId('12659677', '2026-06-04'));
    expect(blockEventId('12659677', '2026-06-04')).not.toBe(blockEventId('12659677', '2026-06-05'));
  });
});
