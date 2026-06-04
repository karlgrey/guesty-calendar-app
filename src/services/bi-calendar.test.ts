import { describe, it, expect } from 'vitest';
import { buildGanttGrid } from './bi-calendar.js';

describe('buildGanttGrid', () => {
  const base = {
    startDate: '2026-06-02',
    dayCount: 14,
    properties: [
      {
        slug: 'farmhouse',
        name: 'Farmhouse',
        availability: [
          { date: '2026-06-02', status: 'booked' },
          { date: '2026-06-03', status: 'available' },
          { date: '2026-06-04', status: 'blocked' },
        ],
        // checkout 06-02 AND checkin 06-02 -> turnover on 06-02
        reservations: [
          { check_in: '2026-05-30', check_out: '2026-06-02' },
          { check_in: '2026-06-02', check_out: '2026-06-05' },
        ],
      },
    ],
  };

  it('produces one row per property with dayCount days', () => {
    const grid = buildGanttGrid(base);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].days).toHaveLength(14);
  });

  it('marks booked, free and turnover correctly', () => {
    const grid = buildGanttGrid(base);
    const days = grid.rows[0].days;
    expect(days[0]).toBe('turnover'); // 06-02 checkout+checkin, overrides booked
    expect(days[1]).toBe('free');     // 06-03 available
    expect(days[2]).toBe('blocked');  // 06-04 availability status 'blocked' -> own state
  });

  it('emits a date label every 7 days', () => {
    const grid = buildGanttGrid(base);
    expect(grid.labels.map((l) => l.index)).toEqual([0, 7]);
    expect(grid.labels[0].label).toBe('2 Jun');
    expect(grid.labels[1].label).toBe('9 Jun');
  });
});
