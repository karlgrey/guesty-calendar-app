// #1376: Mail-Vorlage Strom je Gast (pure)
import { describe, it, expect } from 'vitest';
import { buildPowerStayEmail } from './power-stay-email-template.js';
import { num, num1 } from './power-format.js';
import { renderPowerPage } from '../routes/power.js';
import type { PowerReport } from './power-report-service.js';
import type { PowerRow } from './power-consumption.js';

const stay = (over: Partial<PowerRow> = {}): PowerRow => ({
  kind: 'stay', reservationId: 'r1', guestName: 'Erika Muster', checkInDate: '2026-11-20', checkOutDate: '2026-11-22',
  startUtc: '2026-11-20T15:00:00.000Z', endUtc: '2026-11-22T10:00:00.000Z', nights: 2, days: 1.79,
  status: 'complete', incompleteReason: null, kwh: 87.34, kwhPerNight: 43.67, kwhPerDay: null, deviationPct: 12.4, flagged: false, ...over,
});
const vacancy = (over: Partial<PowerRow> = {}): PowerRow => ({
  kind: 'vacancy', reservationId: null, guestName: null, checkInDate: null, checkOutDate: null,
  startUtc: '2026-11-18T10:00:00.000Z', endUtc: '2026-11-20T15:00:00.000Z', nights: null, days: 2.21,
  status: 'complete', incompleteReason: null, kwh: 20.5, kwhPerNight: null, kwhPerDay: 9.3, deviationPct: null, flagged: false, ...over,
});
const report = (rows: PowerRow[], over: Partial<PowerReport> = {}): PowerReport => ({
  rows, medianKwhPerNight: 38.9, comparisonCount: 7, flaggingActive: true,
  propertySlug: 'farmhouse', propertyName: 'Farmhouse Prasser', timezone: 'Europe/Berlin',
  latestReading: null, generatedAt: '2026-11-22T12:00:00.000Z', ...over,
});
const adminUrl = 'https://app.example.com/admin/strom?property=farmhouse';
const build = (s: PowerRow, vb: PowerRow | null = null, rep: PowerReport = report([s])) =>
  buildPowerStayEmail({ report: rep, stay: s, vacancyBefore: vb, adminUrl });

describe('buildPowerStayEmail', () => {
  it('vollständig: Betreff ohne „auffällig“, alle Felder in HTML und Text', () => {
    const s = stay();
    const m = build(s);
    expect(m.subject).toBe(`Strom Farmhouse Prasser: Erika Muster · ${num(43.67)} kWh/Nacht`);
    expect(m.subject).not.toContain('auffällig');
    for (const out of [m.html, m.text]) {
      expect(out).toContain('Erika Muster');
      expect(out).toContain('20.11.2026 16:00');
      expect(out).toContain('22.11.2026 11:00');
      expect(out).toContain(num(87.34));
      expect(out).toContain(num(43.67));
      expect(out).toContain('+12 %');
      expect(out).toContain('Median 38,9 kWh/Nacht aus 7 vollständig erfassten Buchungen');
      expect(out).toContain('vollständig');
      expect(out).toContain(adminUrl);
      expect(out).not.toMatch(/€|Euro|Kosten/);
    }
    expect(m.text).toContain('Nächte: 2');
    expect(m.text).not.toContain('Markierung');
  });

  it('auffällig: Betreff beginnt mit „auffällig · “', () => {
    const m = build(stay({ flagged: true, kwhPerNight: 80, kwh: 160, deviationPct: 105 }));
    expect(m.subject).toBe(`auffällig · Strom Farmhouse Prasser: Erika Muster · ${num(80)} kWh/Nacht`);
    expect(m.text).toContain('auffällig');
  });

  it('unvollständig (Messlücke): Betreff mit Status, kWh „—“', () => {
    const m = build(stay({ status: 'incomplete', incompleteReason: 'gap', kwh: null, kwhPerNight: null, deviationPct: null }));
    expect(m.subject).toBe('Strom Farmhouse Prasser: Erika Muster · unvollständig (Messlücke)');
    expect(m.text).toContain('kWh gesamt: —');
    expect(m.text).toContain('kWh pro Nacht: —');
    expect(m.text).toContain('Abweichung vom Median: —');
    expect(m.text).toContain('Status: unvollständig (Messlücke)');
  });

  it('unvollständig (Zählerstand gesunken)', () => {
    const m = build(stay({ status: 'incomplete', incompleteReason: 'reset', kwh: null, kwhPerNight: null, deviationPct: null }));
    expect(m.subject).toContain('unvollständig (Zählerstand gesunken)');
  });

  it('ohne Gastnamen: „Gast unbekannt“', () => {
    expect(build(stay({ guestName: null })).subject).toContain('Gast unbekannt');
  });

  it('ohne Median: eigener Text; Hinweis zur Markierung, solange sie nicht aktiv ist', () => {
    const s = stay({ deviationPct: null });
    const m = build(s, null, report([s], { medianKwhPerNight: null, comparisonCount: 0, flaggingActive: false }));
    expect(m.text).toContain('kein Median (noch keine vollständig erfassten Buchungen)');
    expect(m.text).toContain('Markierung „auffällig“ ab 5 Vergleichsbuchungen');
    expect(m.html).toContain('Markierung „auffällig“ ab 5 Vergleichsbuchungen');
  });

  it('Leerstand-Zeile nur bei vollständigem Leerstand mit kWh', () => {
    const s = stay();
    const line = `${num(20.5)} kWh · ${num(9.3)} kWh/Tag · ${num1(2.21)} Tage`;
    const withVac = build(s, vacancy());
    expect(withVac.text).toContain(`Leerstand davor: ${line}`);
    expect(withVac.html).toContain(line);
    expect(build(s, vacancy({ kwhPerDay: null })).text).toContain(`Leerstand davor: ${num(20.5)} kWh · ${num1(2.21)} Tage`);
    expect(build(s, null).text).not.toContain('Leerstand');
    expect(build(s, vacancy({ status: 'incomplete', incompleteReason: 'gap', kwh: null })).text).not.toContain('Leerstand');
    expect(build(s, vacancy({ status: 'running' })).text).not.toContain('Leerstand');
    expect(build(s, vacancy({ kwh: null })).text).not.toContain('Leerstand');
  });

  it('HTML-Escaping des Gastnamens (Betreff bleibt Klartext)', () => {
    const m = build(stay({ guestName: '<b>"Mallory" & Co</b>' }));
    expect(m.html).not.toContain('<b>"Mallory"');
    expect(m.html).toContain('&lt;b&gt;&quot;Mallory&quot; &amp; Co&lt;/b&gt;');
    expect(m.subject).toContain('<b>"Mallory" & Co</b>');
  });

  it('Zahlen wie /admin/strom für dieselbe Zeile', () => {
    const s = stay({ kwh: 1234.56, kwhPerNight: 617.28, deviationPct: 1488 });
    const rep = report([s]);
    const page = renderPowerPage(rep);
    const m = build(s, null, rep);
    for (const v of [num(1234.56), num(617.28), '+1.488 %']) {
      expect(page).toContain(v);
      expect(m.html).toContain(v);
      expect(m.text).toContain(v);
    }
  });
});
