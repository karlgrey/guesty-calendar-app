import { describe, it, expect } from 'vitest';
import { generateBiReportEmail } from './bi-email-templates.js';
import type { BiReportModel } from '../types/bi-report.js';

const model: BiReportModel = {
  generatedAt: '2026-06-02T06:00:00Z',
  weekLabel: '2. Jun 2026',
  currency: 'EUR',
  portfolio: { revenueYtd: 123400, avgOccupancy6wk: 68, bookingsYtd: 181, committedRevenueHorizon: 87200 },
  calendar: {
    startDate: '2026-06-02', dayCount: 7,
    rows: [{ slug: 'farmhouse', name: 'Farmhouse', days: ['booked', 'free', 'turnover', 'booked', 'free', 'free', 'booked'] }],
    labels: [{ index: 0, label: '2 Jun' }],
  },
  arrivals: [
    { date: '2026-06-03', propertySlug: 'u19', propertyName: 'Uferstrasse 19', guestName: 'Max M.', nights: 4, guests: 2, source: 'direct', isTurnover: false },
  ],
  kpis: [
    { slug: 'farmhouse', name: 'Farmhouse', occupancy6wk: 74, occupancy30d: 68, revenueYtd: 32400, revenueMonth: 4850, revenueChangePct: 12, bookingsYtd: 41, adr: 168, currency: 'EUR' },
  ],
  portfolioForecast: [
    { monthLabel: 'Jun', committedPct: 68, projectedFinalPct: 78, bandPct: 4, committedRevenue: 18000, projectedRevenue: 20600, lowData: false },
  ],
  propertyForecasts: [
    { slug: 'farmhouse', name: 'Farmhouse', lowData: false, months: [
      { monthLabel: 'Jun', committedPct: 70, projectedFinalPct: 80, bandPct: 4, committedRevenue: 4000, projectedRevenue: 4600, lowData: false },
    ] },
  ],
};

describe('generateBiReportEmail', () => {
  it('returns html and text', () => {
    const { html, text } = generateBiReportEmail(model);
    expect(html).toContain('<html');
    expect(html).toContain('Farmhouse');
    expect(html).toContain('Uferstrasse 19');
    expect(html).toContain('123');           // portfolio YTD revenue rendered
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Farmhouse');
  });

  it('uses the AirBnB Portfolio Report title and lists property names', () => {
    const { html } = generateBiReportEmail(model);
    expect(html).toContain('AirBnB Portfolio Report');
    expect(html).toContain('1 Properties: Farmhouse'); // enumerates names
  });

  it('labels yearly revenue with the actual year (not "YTD") and explains it', () => {
    const { html } = generateBiReportEmail(model); // generatedAt 2026 -> "Umsatz 2026"
    expect(html).toContain('Umsatz 2026');
    expect(html).not.toContain('Umsatz YTD');
    expect(html.toLowerCase()).toContain('kalenderjahr');
  });

  it('renders arrival dates in German DD.MM.YYYY format', () => {
    const { html, text } = generateBiReportEmail(model); // arrival 2026-06-03
    expect(html).toContain('03.06.2026');
    expect(text).toContain('03.06.2026');
    expect(html).not.toContain('2026-06-03');
  });

  it('renders a low-data marker when a property forecast is flagged', () => {
    const flagged: BiReportModel = {
      ...model,
      propertyForecasts: [{ ...model.propertyForecasts[0], lowData: true }],
    };
    const { html } = generateBiReportEmail(flagged);
    expect(html.toLowerCase()).toContain('dünne datenbasis');
  });
});
