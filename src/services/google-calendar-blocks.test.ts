import { describe, it, expect } from 'vitest';
import { buildBlockSpans, buildBlockEvent, blockEventId, blockLabel, lateCheckoutDates, CLEANING_AFTER_LATE_CHECKOUT_LABEL } from './google-calendar-blocks.js';

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

describe('Folgetag-Block nach Late-Checkout (#793, Zieltag Check-out + 1 seit #802)', () => {
  const late = new Set(['2026-08-05']); // = Check-out 2026-08-04 + 1
  const oneNight = { startDate: '2026-08-05', endExclusive: '2026-08-06', blockType: 'manual' };

  it('1-Nacht-Block an Check-out + 1 einer Late-Checkout-Reservierung -> "Reinigung nach Late-Checkout"', () => {
    const ev = buildBlockEvent(oneNight, 'Farmhouse', 'guesty', late);
    expect(ev.summary).toBe(CLEANING_AFTER_LATE_CHECKOUT_LABEL);
    expect(ev.extendedProperties?.private?.kind).toBe('owner-block'); // Cleanup-Schlüssel bleibt
    expect(ev.start).toEqual({ date: '2026-08-05' });
  });

  it('gleicher Block ohne Late-Checkout-Tag: generisches Label', () => {
    expect(buildBlockEvent(oneNight, 'Farmhouse', 'guesty', new Set()).summary).toBe('Manuell blockiert');
    expect(buildBlockEvent(oneNight, 'Farmhouse', 'guesty').summary).toBe('Manuell blockiert');
  });

  it('mehrtägiger Block bleibt generisch, auch wenn er am Late-Checkout-Tag beginnt', () => {
    const multi = { ...oneNight, endExclusive: '2026-08-08' };
    expect(buildBlockEvent(multi, 'Farmhouse', 'guesty', late).summary).toBe('Manuell blockiert');
  });

  it('Block an anderem Tag bleibt generisch', () => {
    expect(buildBlockEvent({ ...oneNight, startDate: '2026-08-06', endExclusive: '2026-08-07' }, 'F', 'guesty', late).summary).toBe('Manuell blockiert');
  });

  it('lateCheckoutDates: nur planned_departure > Standard zählt', () => {
    const rs = [
      { check_out: '2026-08-05', check_out_localized: '2026-08-05', planned_departure: '18:00' },
      { check_out: '2026-08-09', check_out_localized: null, planned_departure: '12:00' },
      { check_out: '2026-08-12T10:00:00Z', check_out_localized: null, planned_departure: '20:00:00' },
      { check_out: '2026-08-15', check_out_localized: '2026-08-15', planned_departure: null },
    ];
    // Check-out + 1: 05.08. -> 06.08., 12.08. -> 13.08.
    expect([...lateCheckoutDates(rs, '12:00')].sort()).toEqual(['2026-08-06', '2026-08-13']);
    expect(lateCheckoutDates(rs, undefined).size).toBe(0);
  });

  it('lateCheckoutDates: Monats- und Jahreswechsel', () => {
    const mk = (d: string) => ({ check_out: d, check_out_localized: d, planned_departure: '18:00' });
    expect([...lateCheckoutDates([mk('2026-10-31'), mk('2026-12-31')], '12:00')].sort()).toEqual(['2026-11-01', '2027-01-01']);
  });

  it('Check-out-Tag (pt, lokal block_type null) und Check-out+1 (unser Block, manual) bleiben zwei Spans; nur der zweite heißt Reinigung', () => {
    const spans = buildBlockSpans([
      { date: '2026-08-05', status: 'blocked', block_type: null },
      { date: '2026-08-06', status: 'blocked', block_type: 'manual' },
    ]);
    expect(spans).toEqual([
      { startDate: '2026-08-05', endExclusive: '2026-08-06', blockType: null },
      { startDate: '2026-08-06', endExclusive: '2026-08-07', blockType: 'manual' },
    ]);
    const lateDays = lateCheckoutDates([{ check_out: '2026-08-05', check_out_localized: '2026-08-05', planned_departure: '18:00' }], '12:00');
    const [pt, ours] = spans.map((sp) => buildBlockEvent(sp, 'Farmhouse', 'guesty', lateDays));
    expect(pt.summary).not.toBe(CLEANING_AFTER_LATE_CHECKOUT_LABEL);
    expect(ours.summary).toBe(CLEANING_AFTER_LATE_CHECKOUT_LABEL);
    expect(ours.start).toEqual({ date: '2026-08-06' });
    expect(blockEventId('L', '2026-08-05')).not.toBe(blockEventId('L', '2026-08-06'));
  });
});
