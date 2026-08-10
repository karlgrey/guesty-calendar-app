import { describe, it, expect } from 'vitest';
import { generateBiReportEmail } from './bi-email-templates.js';
import type { BiReportModel } from '../types/bi-report.js';

const model: BiReportModel = {
  generatedAt: '2026-06-02T06:00:00Z',
  weekLabel: '2. Jun 2026',
  currency: 'EUR',
  portfolio: { revenueYtd: 123400, avgOccupancy6wk: 68, bookingsYtd: 181, committedRevenueHorizon: 87200, blockedDays6wk: 5 },
  calendar: {
    startDate: '2026-06-02', dayCount: 7,
    rows: [{ slug: 'farmhouse', name: 'Farmhouse', days: ['booked', 'free', 'turnover', 'booked', 'free', 'free', 'booked'] }],
    labels: [{ index: 0, label: '2 Jun' }],
  },
  arrivals: [
    { date: '2026-06-03', propertySlug: 'u19', propertyName: 'Uferstrasse 19', guestName: 'Max M.', nights: 4, guests: 2, source: 'direct', isTurnover: false },
  ],
  kpis: [
    { slug: 'farmhouse', name: 'Farmhouse', occupancy6wk: 74, occupancy30d: 68, revenueYtd: 32400, revenueMonth: 4850, revenueChangePct: 12, bookingsYtd: 41, adr: 168, blockedDays6wk: 3, currency: 'EUR', estimatedCount: 0 },
  ],
  dataWarnings: [],
  portfolioForecast: [
    { monthLabel: 'Jun', committedRevenue: 18000, expectedRevenue: 19500, lowRevenue: 18000, highRevenue: 21000, confidence: 'hoch', method: 'historical', isOpen: false },
    { monthLabel: 'Jul', committedRevenue: 0, expectedRevenue: 0, lowRevenue: 0, highRevenue: 0, confidence: 'niedrig', method: 'pickup', isOpen: true },
  ],
  propertyForecasts: [
    { slug: 'farmhouse', name: 'Farmhouse', committedTotal: 28000, expectedTotal: 41000, highTotal: 52000, confidence: 'hoch', methodLabel: 'überw. Vorjahr', months: [] },
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
    expect(html).toContain('Block-Tg');   // KPI table block-days column header
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

  it('renders the forecast table, method label, confidence badge and "noch offen"', () => {
    const { html } = generateBiReportEmail(model);
    expect(html).toContain('überw. Vorjahr');        // per-property method label
    expect(html.toLowerCase()).toContain('noch offen'); // isOpen month
    expect(html.toLowerCase()).toContain('so entsteht die prognose'); // methodology sentence
    expect(html).not.toContain('±');                 // old band markup gone
    expect(html).not.toContain('position:absolute'); // range bar must be email-safe (table-based)
  });

  it('does not render a staleness warning when nothing is stale (field absent)', () => {
    const { html, text } = generateBiReportEmail(model); // model has no staleAirbnbMailSources field
    expect(html.toLowerCase()).not.toContain('airbnb-mail');
    expect(text.toLowerCase()).not.toContain('airbnb-mail');
  });

  it('renders a staleness warning banner for stale airbnb-mail properties (#327)', () => {
    const staleModel: BiReportModel = {
      ...model,
      staleAirbnbMailSources: [{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: 240 }],
    };
    const { html, text } = generateBiReportEmail(staleModel);
    expect(html).toContain('Florence');
    expect(html.toLowerCase()).toContain('airbnb-mail');
    expect(html).toMatch(/240/);
    expect(text).toContain('Florence');
    expect(text.toLowerCase()).toContain('airbnb-mail');
  });

  it('renders "nie erfolgreich synchronisiert" for a property that never synced', () => {
    const staleModel: BiReportModel = {
      ...model,
      staleAirbnbMailSources: [{ slug: 'firenze-loft', name: 'Florence', hoursSinceSync: null }],
    };
    const { html, text } = generateBiReportEmail(staleModel);
    expect(html.toLowerCase()).toContain('nie');
    expect(text.toLowerCase()).toContain('nie');
  });
});

describe('generateBiReportEmail — estimate markers & data-quality warnings', () => {
  it('renders the ≈ prefix and a Datenqualität section when there are estimates/warnings', () => {
    const withWarnings: BiReportModel = {
      ...model,
      kpis: [{ ...model.kpis[0], estimatedCount: 1 }],
      dataWarnings: ['Urban Luxury Loft - Florence: Buchung HMGONE00001 fehlt im Airbnb-Kalender — prüfen (Storno?)'],
    };
    const { html, text } = generateBiReportEmail(withWarnings);
    expect(html).toContain('≈');
    expect(html).toContain('Datenqualität');
    expect(html).toContain('HMGONE00001');
    expect(text).toContain('Datenqualität');
    expect(text).toContain('HMGONE00001');
  });

  it('omits the ≈ prefix and Datenqualität section when nothing is estimated/warned', () => {
    const { html, text } = generateBiReportEmail(model); // estimatedCount 0 everywhere, no warnings
    expect(html).not.toContain('≈');
    expect(html).not.toContain('Datenqualität');
    expect(text).not.toContain('Datenqualität');
  });
});
