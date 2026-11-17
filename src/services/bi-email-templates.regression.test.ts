/**
 * Regression (#1223): Ein Wochen-Modell ohne `labels` rendert byte-gleich wie vor
 * Einführung der Monats-Labels. Die Referenz wurde VOR dem Umbau erzeugt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateBiReportEmail } from './bi-email-templates.js';
import { weeklyModelFixture } from './__fixtures__/bi-report-model.fixture.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('generateBiReportEmail — Wochen-Regression', () => {
  it('rendert HTML und Text byte-gleich zur Referenz', () => {
    const r = generateBiReportEmail(weeklyModelFixture);
    expect(r.html).toBe(readFileSync(join(dir, 'bi-email-weekly-reference.html'), 'utf8'));
    expect(r.text).toBe(readFileSync(join(dir, 'bi-email-weekly-reference.txt'), 'utf8'));
  });

  it('nutzt Monats-Labels, wenn gesetzt', () => {
    const r = generateBiReportEmail({
      ...weeklyModelFixture,
      weekLabel: 'Oktober 2026',
      arrivals: [],
      labels: {
        title: 'AirBnB Portfolio Report · Monat Oktober 2026',
        calendarHeading: '① Übersichtskalender · Oktober 2026',
        arrivalsHeading: '② Anreisen &amp; Turnovers · Oktober 2026',
        arrivalsEmpty: 'Keine Anreisen im Oktober 2026.',
        kpiOcc6wk: 'Bel. Monat',
        kpiOcc30d: 'Bel. Vormon.',
        statOccupancy: 'Ø Belegung Monat',
        textOccupancy: 'Ø Belegung Monat',
        textArrivalsHeading: 'Anreisen im Zeitraum:',
      },
    });
    expect(r.html).toContain('📊 AirBnB Portfolio Report · Monat Oktober 2026');
    expect(r.html).toContain('① Übersichtskalender · Oktober 2026');
    expect(r.html).toContain('② Anreisen &amp; Turnovers · Oktober 2026');
    expect(r.html).toContain('Keine Anreisen im Oktober 2026.');
    expect(r.html).toContain('Bel. Monat');
    expect(r.html).toContain('Ø Belegung Monat');
    expect(r.html).not.toContain('Bel. 6Wo');
    expect(r.html).not.toContain('6 Wochen');
    expect(r.text).toContain('Anreisen im Zeitraum:');
    expect(r.text.split('\n')[0]).toBe('AirBnB Portfolio Report · Monat Oktober 2026');
  });
});
