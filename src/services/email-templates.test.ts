import { describe, it, expect } from 'vitest';
import { generateWeeklySummaryEmail } from './email-templates.js';

const baseData = {
  propertyTitle: 'Urban Luxury Loft - Florence',
  currency: 'EUR',
  allTimeStats: {
    total_bookings: 40, total_revenue: 32000, total_booked_days: 400,
    start_date: '2024-01-01', end_date: null,
  },
  currentYearStats: { year: 2026, total_bookings: 14, total_revenue: 7820.45, total_booked_days: 73 },
  occupancyRates: { next4Weeks: 0.5, last3Months: 0.6 },
  conversionRate: { inquiries: 10, confirmed: 5, total: 15, rate: 0.5 },
  upcomingBookings: [],
};

describe('generateWeeklySummaryEmail — estimate markers', () => {
  it('renders the ≈ prefix and warning when estimateInfo is set', () => {
    const { html, text } = generateWeeklySummaryEmail({
      ...baseData,
      estimateInfo: { count: 2, revenue: 1409.04 },
    });
    expect(html).toContain('≈');
    expect(html).toContain('2 Buchung(en) mit geschätztem Betrag');
    expect(text).toContain('2 Buchung(en) mit geschätztem Betrag');
  });

  it('omits the estimate warning when estimateInfo is absent', () => {
    const { html, text } = generateWeeklySummaryEmail(baseData);
    expect(html).not.toContain('Buchung(en) mit geschätztem Betrag');
    expect(text).not.toContain('Buchung(en) mit geschätztem Betrag');
  });
});
