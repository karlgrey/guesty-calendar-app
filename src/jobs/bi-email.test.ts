import { describe, it, expect, vi } from 'vitest';

vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn(() => ({ title: 'T', nickname: null, currency: 'EUR' })),
}));
vi.mock('../repositories/availability-repository.js', () => ({
  getAllTimeStats: vi.fn(() => ({ totalBookings: 40, totalRevenue: 30000, totalBookedDays: 200, startDate: '2025-07-01', endDate: '2026-06-02' })),
  getCurrentYearStats: vi.fn(() => ({ year: 2026, totalBookings: 20, totalRevenue: 15000, totalBookedDays: 100 })),
  getOccupancyRate: vi.fn(() => 70),
  getOccupancyCounts: vi.fn(() => ({ occupiedDays: 20, totalDays: 30 })),
  getAvailability: vi.fn(() => []),
}));
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationsByPeriod: vi.fn(() => [
    { reservation_id: 'r1', check_in: '2026-06-03', check_out: '2026-06-07', nights_count: 4, guest_name: 'Max M.', guests_count: 2, source: 'direct', platform: null, host_payout: 800, total_price: 800, status: 'confirmed' },
  ]),
  getReservationsInRange: vi.fn(() => []),
  getLeadTimeSamples: vi.fn(() => Array.from({ length: 30 }, () => ({ checkIn: '2026-07-01', reservedAt: '2026-06-01' }))),
  getRevenueForCheckInMonth: vi.fn(() => 4000),
}));

import { buildBiReportModel } from './bi-email.js';
import type { PropertyConfig } from '../config/properties.js';

const prop = (slug: string, name: string): PropertyConfig => ({
  slug, name, provider: 'guesty', guestyPropertyId: `id-${slug}`,
  timezone: 'Europe/Berlin', currency: 'EUR',
  bookingRecipientEmail: 'b@e.com', bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
});

describe('buildBiReportModel', () => {
  it('assembles portfolio totals, calendar, arrivals, kpis and forecasts', () => {
    const model = buildBiReportModel(
      [prop('farmhouse', 'Farmhouse'), prop('u19', 'Uferstrasse 19')],
      new Date('2026-06-02T06:00:00Z'),
      6
    );
    expect(model.kpis).toHaveLength(2);
    expect(model.calendar.rows).toHaveLength(2);
    expect(model.calendar.dayCount).toBe(42);
    expect(model.portfolio.bookingsYtd).toBe(40); // 20 + 20 current-year bookings
    expect(model.arrivals.length).toBeGreaterThan(0);
    expect(model.arrivals[0].guestName).toBe('Max M.');
    expect(model.portfolioForecast).toHaveLength(6);
    expect(model.propertyForecasts).toHaveLength(2);
  });

  it('isolates a failing property without throwing', () => {
    const ok = prop('farmhouse', 'Farmhouse');
    const broken = { ...prop('bad', 'Bad'), guestyPropertyId: undefined, provider: 'guesty' as const };
    const model = buildBiReportModel([ok, broken], new Date('2026-06-02T06:00:00Z'), 6);
    // broken property has no listing id -> skipped, but model still builds
    expect(model.kpis.length).toBe(1);
  });
});
