import { describe, it, expect } from 'vitest';
import {
  buildConsistencyAlertEmail,
  shouldSendConsistencyAlert,
  type ConsistencyAlertReport,
  type StaleHold,
} from './consistency-alert-email.js';

function emptyReport(overrides: Partial<ConsistencyAlertReport> = {}): ConsistencyAlertReport {
  return {
    checkedAt: '2026-08-27T06:00:00.000Z',
    windowDays: 28,
    from: '2026-08-27',
    to: '2026-09-24',
    totalIssues: 0,
    properties: [],
    ...overrides,
  };
}

function reportWithIssues(): ConsistencyAlertReport {
  return emptyReport({
    totalIssues: 3,
    properties: [
      {
        slug: 'farmhouse',
        name: 'Farmhouse Prasser',
        ok: false,
        missing: [
          {
            type: 'reservation',
            start: '2026-10-04',
            endExclusive: '2026-10-07',
            guestName: 'Louisa Strasser',
          },
        ],
        extra: [{ start: '2026-09-01', end: '2026-09-02', summary: 'Handwerker vor Ort' }],
        mismatched: [
          {
            summary: 'Max Mustermann (2N, 2 Gäste)',
            expected: { start: '2026-09-12', endExclusive: '2026-09-14' },
            actual: { start: '2026-09-12', endExclusive: '2026-09-15' },
          },
        ],
        error: null,
      },
      {
        slug: 'u19',
        name: 'Ferienwohnung Uferstraße 19',
        ok: false,
        missing: [],
        extra: [],
        mismatched: [],
        error: 'Guesty API 502',
      },
    ],
  });
}

const staleHold: StaleHold = {
  provider: 'guesty',
  guestName: 'Alte Anfrage GmbH',
  property: { slug: 'farmhouse', name: 'Farmhouse Prasser' },
  checkIn: '2026-10-20',
  createdAt: '2026-08-10T09:00:00.000Z',
};

describe('shouldSendConsistencyAlert', () => {
  it('kein Versandfall bei leerem Report ohne Holds', () => {
    expect(shouldSendConsistencyAlert(emptyReport(), [])).toBe(false);
  });

  it('Versandfall wenn totalIssues > 0', () => {
    expect(shouldSendConsistencyAlert(reportWithIssues(), [])).toBe(true);
  });

  it('Versandfall wenn mindestens ein Hold älter als 7 Tage vorliegt', () => {
    expect(shouldSendConsistencyAlert(emptyReport(), [staleHold])).toBe(true);
  });
});

describe('buildConsistencyAlertEmail', () => {
  it('Betreff nennt die Anzahl der Abweichungen', () => {
    const { subject } = buildConsistencyAlertEmail(reportWithIssues(), []);
    expect(subject).toContain('⚠️');
    expect(subject).toContain('3');
  });

  it('Betreff weist zusätzlich auf offene Holds hin', () => {
    const { subject } = buildConsistencyAlertEmail(emptyReport(), [staleHold]);
    expect(subject).toMatch(/Hold/i);
  });

  it('HTML-Body enthält Property, Gastname/Summary und Zeitraum je Befund', () => {
    const { html } = buildConsistencyAlertEmail(reportWithIssues(), []);
    expect(html).toContain('Farmhouse Prasser');
    expect(html).toContain('Louisa Strasser');
    expect(html).toContain('2026-10-04');
    expect(html).toContain('Handwerker vor Ort');
    expect(html).toContain('Max Mustermann (2N, 2 Gäste)');
    expect(html).toContain('Guesty API 502');
  });

  it('HTML-Body enthält einen Abschnitt für offene Holds > 7 Tage', () => {
    const { html } = buildConsistencyAlertEmail(emptyReport(), [staleHold]);
    expect(html).toContain('Offene Holds');
    expect(html).toContain('Alte Anfrage GmbH');
    expect(html).toContain('2026-10-20');
  });

  it('Text-Variante enthält dieselben Kerninhalte wie HTML', () => {
    const { text } = buildConsistencyAlertEmail(reportWithIssues(), [staleHold]);
    expect(text).toContain('Farmhouse Prasser');
    expect(text).toContain('Louisa Strasser');
    expect(text).toContain('Alte Anfrage GmbH');
  });

  it('F8(e): esc() escaped auch Anführungszeichen (Gastname mit ")', () => {
    const report = emptyReport({
      totalIssues: 1,
      properties: [
        {
          slug: 'farmhouse', name: 'Farmhouse Prasser', ok: false,
          missing: [{ type: 'reservation', start: '2026-10-04', endExclusive: '2026-10-07', guestName: 'Anna "Ännchen" Muster' }],
          extra: [], mismatched: [], error: null,
        },
      ],
    });
    const { html } = buildConsistencyAlertEmail(report, []);
    expect(html).not.toContain('"Ännchen"');
    expect(html).toContain('&quot;Ännchen&quot;');
  });

  it('F4: erwähnt Hold-Sweep-Provider-Fehler in HTML und Text', () => {
    const { html, text } = buildConsistencyAlertEmail(emptyReport(), [], [
      { provider: 'hostex', error: 'Hostex 500' },
    ]);
    expect(html).toContain('hostex');
    expect(html).toContain('Hostex 500');
    expect(text).toContain('hostex');
    expect(text).toContain('Hostex 500');
  });

  it('property ohne Befunde und ohne Fehler wird nicht aufgeführt', () => {
    const report = reportWithIssues();
    report.properties.push({
      slug: 'ok-prop', name: 'OK Property', ok: true,
      missing: [], extra: [], mismatched: [], error: null,
    });
    const { html } = buildConsistencyAlertEmail(report, []);
    expect(html).not.toContain('OK Property');
  });
});
