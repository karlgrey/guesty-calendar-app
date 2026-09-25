import { describe, it, expect } from 'vitest';
import { groupBlockedRanges } from './availability-blocks.js';

describe('groupBlockedRanges (#725, Hostex Owner-Blocks)', () => {
  it('gruppiert aufeinanderfolgende gesperrte Tage zu Bereichen (3 blocked, 1 frei, 2 blocked → 2 Ranges)', () => {
    const days = [
      { date: '2026-07-19', available: false, remarks: 'Sommercamp' },
      { date: '2026-07-20', available: false, remarks: '' },
      { date: '2026-07-21', available: false, remarks: '' },
      { date: '2026-07-22', available: true, remarks: '' },
      { date: '2026-07-23', available: false, remarks: 'Zweiter Block' },
      { date: '2026-07-24', available: false, remarks: '' },
    ];
    expect(groupBlockedRanges(days)).toEqual([
      { from: '2026-07-19', to: '2026-07-21', nights: 3, remarks: 'Sommercamp' },
      { from: '2026-07-23', to: '2026-07-24', nights: 2, remarks: 'Zweiter Block' },
    ]);
  });

  it('leere Liste → keine Bereiche', () => {
    expect(groupBlockedRanges([])).toEqual([]);
  });

  it('alle Tage frei → keine Bereiche', () => {
    const days = [
      { date: '2026-07-19', available: true },
      { date: '2026-07-20', available: true },
    ];
    expect(groupBlockedRanges(days)).toEqual([]);
  });

  it('alle Tage gesperrt → ein Bereich über die gesamte Liste', () => {
    const days = [
      { date: '2026-07-19', available: false, remarks: 'Sommercamp' },
      { date: '2026-07-20', available: false, remarks: '' },
    ];
    expect(groupBlockedRanges(days)).toEqual([
      { from: '2026-07-19', to: '2026-07-20', nights: 2, remarks: 'Sommercamp' },
    ]);
  });

  it('ein einzelner gesperrter Tag → Bereich mit from === to, nights 1', () => {
    const days = [{ date: '2026-07-19', available: false, remarks: 'Einzeltag' }];
    expect(groupBlockedRanges(days)).toEqual([
      { from: '2026-07-19', to: '2026-07-19', nights: 1, remarks: 'Einzeltag' },
    ]);
  });

  it('fehlende remarks → leerer String statt undefined', () => {
    const days = [{ date: '2026-07-19', available: false }];
    expect(groupBlockedRanges(days)).toEqual([
      { from: '2026-07-19', to: '2026-07-19', nights: 1, remarks: '' },
    ]);
  });

  it('gesperrter Bereich am Ende der Liste wird trotzdem geschlossen', () => {
    const days = [
      { date: '2026-07-19', available: true },
      { date: '2026-07-20', available: false, remarks: 'Tail' },
      { date: '2026-07-21', available: false },
    ];
    expect(groupBlockedRanges(days)).toEqual([
      { from: '2026-07-20', to: '2026-07-21', nights: 2, remarks: 'Tail' },
    ]);
  });
});
