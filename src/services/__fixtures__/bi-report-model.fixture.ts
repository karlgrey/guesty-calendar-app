/** Festes Wochen-Modell (ohne labels) für den Byte-Regressionstest des BI-Renderers. */
import type { BiReportModel } from '../../types/bi-report.js';

export const weeklyModelFixture: BiReportModel = {
  generatedAt: '2026-06-02T06:00:00.000Z',
  weekLabel: '2. Jun 2026',
  currency: 'EUR',
  portfolio: { revenueYtd: 45000, avgOccupancy6wk: 66, bookingsYtd: 60, committedRevenueHorizon: 12000, blockedDays6wk: 5 },
  calendar: {
    startDate: '2026-06-02',
    dayCount: 14,
    labels: [{ index: 0, label: '2 Jun' }, { index: 7, label: '9 Jun' }],
    rows: [
      { slug: 'a', name: 'Farmhouse', days: ['booked', 'booked', 'free', 'turnover', 'free', 'free', 'booked', 'booked', 'free', 'free', 'free', 'free', 'booked', 'booked'] },
      { slug: 'b', name: 'Uferstrasse <19>', days: Array(14).fill('free') },
    ],
  },
  arrivals: [
    { date: '2026-06-03', propertySlug: 'a', propertyName: 'Farmhouse', guestName: 'Max M.', nights: 4, guests: 2, source: 'direct', isTurnover: true },
    { date: '2026-06-09', propertySlug: 'b', propertyName: 'Uferstrasse <19>', guestName: 'Anna & Co', nights: 3, guests: 3, source: 'airbnb2', isTurnover: false },
  ],
  kpis: [
    { slug: 'a', name: 'Farmhouse', occupancy6wk: 70, occupancy30d: 62, revenueYtd: 30000, revenueMonth: 4000, revenueChangePct: 12, bookingsYtd: 40, adr: 150, blockedDays6wk: 3, currency: 'EUR', estimatedCount: 0 },
    { slug: 'b', name: 'Uferstrasse <19>', occupancy6wk: 62, occupancy30d: 55, revenueYtd: 15000, revenueMonth: 2000, revenueChangePct: -8, bookingsYtd: 20, adr: 120, blockedDays6wk: 2, currency: 'EUR', estimatedCount: 2 },
  ],
  portfolioForecast: [
    { monthLabel: 'Jun', committedRevenue: 6000, expectedRevenue: 9000, lowRevenue: 7000, highRevenue: 11000, confidence: 'hoch', method: 'historical', isOpen: false },
    { monthLabel: 'Jul', committedRevenue: 0, expectedRevenue: 0, lowRevenue: 0, highRevenue: 0, confidence: 'niedrig', method: 'pickup', isOpen: true },
  ],
  propertyForecasts: [
    { slug: 'a', name: 'Farmhouse', committedTotal: 6000, expectedTotal: 9000, highTotal: 11000, confidence: 'mittel', methodLabel: 'Vorjahr', months: [] },
  ],
  staleAirbnbMailSources: [{ slug: 'b', name: 'Uferstrasse <19>', hoursSinceSync: 30 }],
  dataWarnings: ['Farmhouse: Buchung X fehlt'],
};
