// #1169: Stromverbrauch je Buchung — pure Berechnung
import { describe, it, expect } from 'vitest';
import { computePowerRows, readingAt, median, type ReadingPoint, type StayInput } from './power-consumption.js';

const H = 3600_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (hours: number) => new Date(T0 + hours * H).toISOString();
/** stündliche Stände von `fromH` bis `toH` mit `perHour` kWh/h ab Startwert `base` */
function hourly(fromH: number, toH: number, perHour: number, base = 1000): ReadingPoint[] {
  const out: ReadingPoint[] = [];
  for (let h = fromH; h <= toH; h++) out.push({ measuredAt: iso(h), kwh: base + (h - fromH) * perHour });
  return out;
}
function stay(id: string, startH: number, endH: number, nights: number, guest = `Gast ${id}`): StayInput {
  return {
    reservationId: id, guestName: guest, nights,
    checkInDate: iso(startH).slice(0, 10), checkOutDate: iso(endH).slice(0, 10),
    startUtc: iso(startH), endUtc: iso(endH),
  };
}
const FAR_FUTURE = T0 + 10_000 * H;

describe('readingAt', () => {
  const r: ReadingPoint[] = [{ measuredAt: iso(0), kwh: 100 }, { measuredAt: iso(2), kwh: 104 }, { measuredAt: iso(10), kwh: 200 }];

  it('exakter Treffer liefert den Stand', () => {
    expect(readingAt(r, T0 + 2 * H)).toBe(104);
  });
  it('interpoliert linear zwischen Stand davor und danach (≤ 3 h)', () => {
    expect(readingAt(r, T0 + 0.5 * H)).toBeCloseTo(101, 6);
    expect(readingAt(r, T0 + 1.5 * H)).toBeCloseTo(103, 6);
  });
  it('genau 3 h Abstand ist noch erlaubt', () => {
    const g: ReadingPoint[] = [{ measuredAt: iso(0), kwh: 0 }, { measuredAt: iso(3), kwh: 3 }];
    expect(readingAt(g, T0 + 1 * H)).toBeCloseTo(1, 6);
  });
  it('Lücke > 3 h → null', () => {
    expect(readingAt(r, T0 + 5 * H)).toBeNull();
  });
  it('kein Stand davor oder danach → null', () => {
    expect(readingAt(r, T0 - H)).toBeNull();
    expect(readingAt(r, T0 + 11 * H)).toBeNull();
    expect(readingAt([], T0)).toBeNull();
  });
});

describe('median', () => {
  it('ungerade/gerade/leer', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('computePowerRows', () => {
  it('Verbrauch = Stand Check-out − Stand Check-in, interpoliert auf halbe Stunden', () => {
    // Stände stündlich, 2 kWh/h; Check-in 10:30, Check-out 2 Tage später 10:30
    const readings = hourly(0, 100, 2);
    const res = computePowerRows([stay('a', 10.5, 58.5, 2)], readings, FAR_FUTURE);
    const row = res.rows[0];
    expect(row).toMatchObject({ kind: 'stay', status: 'complete', kwh: 96, kwhPerNight: 48, nights: 2 });
  });

  it('Lücke > 3 h am Check-in → unvollständig (gap), keine Zahl', () => {
    const readings = [...hourly(0, 5, 1), ...hourly(12, 80, 1, 1012)];
    const row = computePowerRows([stay('a', 8, 60, 2)], readings, FAR_FUTURE).rows[0];
    expect(row).toMatchObject({ status: 'incomplete', incompleteReason: 'gap', kwh: null, kwhPerNight: null, flagged: false });
  });

  it('Lücke am Check-out → unvollständig (gap)', () => {
    const readings = hourly(0, 30, 1);
    const row = computePowerRows([stay('a', 5, 60, 2)], readings, FAR_FUTURE).rows[0];
    expect(row).toMatchObject({ status: 'incomplete', incompleteReason: 'gap', kwh: null });
  });

  it('sinkender Zählerstand im Zeitraum (Reset) → unvollständig (reset)', () => {
    const readings = [...hourly(0, 30, 1, 5000), ...hourly(31, 80, 1, 10)];
    const row = computePowerRows([stay('a', 5, 60, 2)], readings, FAR_FUTURE).rows[0];
    expect(row).toMatchObject({ status: 'incomplete', incompleteReason: 'reset', kwh: null });
  });

  it('Reset außerhalb des Zeitraums stört nicht', () => {
    const readings = [...hourly(0, 3, 1, 5000), ...hourly(4, 80, 1, 10)];
    const row = computePowerRows([stay('a', 10, 58, 2)], readings, FAR_FUTURE).rows[0];
    expect(row).toMatchObject({ status: 'complete', kwh: 48 });
  });

  it('Leerstand zwischen Check-out und nächstem Check-in als eigene Zeile mit kWh und kWh/Tag', () => {
    const readings = hourly(0, 200, 1);
    const res = computePowerRows([stay('b', 72, 120, 2), stay('a', 0, 48, 2)], readings, FAR_FUTURE);
    // letzte Zeile: laufender Leerstand nach dem letzten Check-out (kein Folge-Check-in bekannt)
    expect(res.rows.map((r) => r.kind)).toEqual(['stay', 'vacancy', 'stay', 'vacancy']);
    expect(res.rows[3]).toMatchObject({ status: 'running', kwh: 80 });
    const v = res.rows[1];
    expect(v).toMatchObject({ kind: 'vacancy', status: 'complete', kwh: 24, days: 1, kwhPerDay: 24, nights: null, flagged: false });
    expect(v.startUtc).toBe(iso(48));
    expect(v.endUtc).toBe(iso(72));
  });

  it('kein Leerstand bei nahtlosem Wechsel', () => {
    const res = computePowerRows([stay('a', 0, 48, 2), stay('b', 48, 96, 2)], hourly(0, 100, 1), FAR_FUTURE);
    expect(res.rows.map((r) => r.kind)).toEqual(['stay', 'stay', 'vacancy']);
  });

  it('Median-Schwelle: Markierung erst ab 5 Vergleichsbuchungen, > 50 % über Median', () => {
    // vier normale Buchungen (10 kWh/Nacht) + eine teure (20 kWh/Nacht), je 1 Nacht, Abstand 48 h
    const readings: ReadingPoint[] = [];
    let kwh = 0;
    const perNight = [10, 10, 10, 10, 20, 10];
    for (let h = 0; h <= 48 * perNight.length; h++) {
      readings.push({ measuredAt: iso(h), kwh });
      const idx = Math.floor(h / 48);
      const inStay = h % 48 < 24;
      kwh += inStay ? (perNight[idx] ?? 0) / 24 : 0.1;
    }
    const stays = perNight.map((_, i) => stay(`s${i}`, i * 48, i * 48 + 24, 1));

    const four = computePowerRows(stays.slice(0, 4), readings, FAR_FUTURE);
    expect(four.comparisonCount).toBe(4);
    expect(four.flaggingActive).toBe(false);

    const five = computePowerRows(stays.slice(0, 5), readings, FAR_FUTURE);
    expect(five.comparisonCount).toBe(5);
    expect(five.flaggingActive).toBe(true);
    expect(five.medianKwhPerNight).toBeCloseTo(10, 1);
    const expensive = five.rows.find((r) => r.reservationId === 's4')!;
    expect(expensive.flagged).toBe(true);
    expect(expensive.deviationPct).toBe(100);
    expect(five.rows.filter((r) => r.flagged)).toHaveLength(1);

    // vor der Schwelle: Zahlen da, aber keine Markierung
    const fourWithExpensive = computePowerRows([stays[0], stays[1], stays[2], stays[4]], readings, FAR_FUTURE);
    const exp4 = fourWithExpensive.rows.find((r) => r.reservationId === 's4')!;
    expect(exp4.flagged).toBe(false);
    expect(exp4.kwhPerNight).toBeCloseTo(20, 1);
    expect(exp4.deviationPct).not.toBeNull();
  });

  it('genau 50 % über Median ist noch nicht auffällig', () => {
    const readings: ReadingPoint[] = [];
    let kwh = 0;
    const perNight = [10, 10, 10, 10, 15];
    for (let h = 0; h <= 48 * perNight.length; h++) {
      readings.push({ measuredAt: iso(h), kwh });
      const idx = Math.floor(h / 48);
      kwh += h % 48 < 24 ? (perNight[idx] ?? 0) / 24 : 0;
    }
    const res = computePowerRows(perNight.map((_, i) => stay(`s${i}`, i * 48, i * 48 + 24, 1)), readings, FAR_FUTURE);
    expect(res.flaggingActive).toBe(true);
    expect(res.rows.find((r) => r.reservationId === 's4')!.flagged).toBe(false);
  });

  it('unvollständige Buchungen zählen nicht in den Median', () => {
    const readings = hourly(0, 100, 1);
    const res = computePowerRows([stay('a', 0, 24, 1), stay('b', 200, 224, 1)], readings, FAR_FUTURE);
    expect(res.comparisonCount).toBe(1);
  });

  it('laufende Buchung: Verbrauch bis zum letzten Stand, nicht im Median, Folge-Leerstand entfällt', () => {
    const readings = hourly(0, 60, 1);
    const now = T0 + 60.5 * H;
    const res = computePowerRows([stay('a', 12, 108, 4)], readings, now);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ status: 'running', kwh: 48, kwhPerNight: 24 });
    expect(res.comparisonCount).toBe(0);
  });

  it('laufender Leerstand nach dem letzten Check-out (nächster Check-in in der Zukunft)', () => {
    const readings = hourly(0, 100, 1);
    const now = T0 + 100.2 * H;
    const res = computePowerRows([stay('a', 0, 48, 2), stay('b', 150, 200, 2)], readings, now);
    expect(res.rows.map((r) => r.kind)).toEqual(['stay', 'vacancy']);
    expect(res.rows[1]).toMatchObject({ status: 'running', kwh: 52 });
    expect(res.rows[1].endUtc).toBe(iso(150));
  });

  it('künftige Buchungen werden nicht ausgewertet', () => {
    const res = computePowerRows([stay('a', 500, 548, 2)], hourly(0, 10, 1), T0 + 10 * H);
    expect(res.rows).toHaveLength(0);
  });
});
