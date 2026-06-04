import { describe, it, expect } from 'vitest';
import { buildBlockSpans, buildBlockEvent, blockEventId } from './google-calendar-blocks.js';

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
});

describe('buildBlockEvent', () => {
  it('builds an all-day event with reason-based title and cleanup marker', () => {
    const ev = buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-07', blockType: 'owner' }, 'Bootshaus');
    expect(ev.summary).toBe('🔒 Owner-Block');
    expect(ev.start).toEqual({ date: '2026-06-04' });
    expect(ev.end).toEqual({ date: '2026-06-07' });
    expect(ev.location).toBe('Bootshaus');
    expect(ev.transparency).toBe('opaque');
    expect(ev.extendedProperties?.private?.kind).toBe('owner-block');
  });

  it('titles by reason where known, generic otherwise', () => {
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'maintenance' }, 'X').summary).toBe('🔒 Blockiert (Wartung)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: 'manual' }, 'X').summary).toBe('🔒 Blockiert (manuell)');
    expect(buildBlockEvent({ startDate: '2026-06-04', endExclusive: '2026-06-05', blockType: null }, 'X').summary).toBe('🔒 Blockiert');
  });
});

describe('blockEventId', () => {
  it('is stable and namespaced', () => {
    expect(blockEventId('12659677', '2026-06-04')).toBe(blockEventId('12659677', '2026-06-04'));
    expect(blockEventId('12659677', '2026-06-04')).not.toBe(blockEventId('12659677', '2026-06-05'));
  });
});
