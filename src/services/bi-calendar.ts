/**
 * BI calendar (pure functions) — builds a per-property Gantt grid of
 * booked / free / turnover day states plus date labels every 7 days.
 */
import { addDays, format } from 'date-fns';

export type DayState = 'booked' | 'free' | 'turnover';

export interface PropertyGanttRow {
  slug: string;
  name: string;
  days: DayState[];
}

export interface DateLabel {
  index: number;
  label: string;
}

export interface GanttGrid {
  startDate: string;
  dayCount: number;
  rows: PropertyGanttRow[];
  labels: DateLabel[];
}

export interface GanttInput {
  startDate: string; // YYYY-MM-DD
  dayCount: number;  // e.g. 42
  properties: Array<{
    slug: string;
    name: string;
    availability: Array<{ date: string; status: string }>;
    reservations: Array<{ check_in: string; check_out: string }>;
  }>;
}

const day = (iso: string) => iso.slice(0, 10);

export function buildGanttGrid(input: GanttInput): GanttGrid {
  const start = new Date(`${input.startDate}T00:00:00`);

  const rows: PropertyGanttRow[] = input.properties.map((p) => {
    const statusByDate = new Map(p.availability.map((a) => [day(a.date), a.status]));
    const checkIns = new Set(p.reservations.map((r) => day(r.check_in)));
    const checkOuts = new Set(p.reservations.map((r) => day(r.check_out)));

    const days: DayState[] = [];
    for (let i = 0; i < input.dayCount; i++) {
      const d = format(addDays(start, i), 'yyyy-MM-dd');
      const isTurnover = checkIns.has(d) && checkOuts.has(d);
      if (isTurnover) {
        days.push('turnover');
        continue;
      }
      const status = statusByDate.get(d);
      days.push(status === 'booked' || status === 'blocked' ? 'booked' : 'free');
    }
    return { slug: p.slug, name: p.name, days };
  });

  const labels: DateLabel[] = [];
  for (let i = 0; i < input.dayCount; i += 7) {
    labels.push({ index: i, label: format(addDays(start, i), 'd MMM') });
  }

  return { startDate: input.startDate, dayCount: input.dayCount, rows, labels };
}
