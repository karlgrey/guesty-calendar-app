/**
 * #1223: Weekly Summary — Empfänger aus der DB, Florenz-Stichtag (reportingUntil).
 * sendEmail ist gemockt (kein echter Versand).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn(() => ({ title: 'T', nickname: 'Florenz', currency: 'EUR' })),
}));
vi.mock('../repositories/availability-repository.js', () => ({
  getAllTimeStats: vi.fn(() => ({ totalBookings: 1, totalRevenue: 1, totalBookedDays: 1, startDate: '2025-01-01', endDate: '2026-01-01' })),
  getOccupancyRate: vi.fn(() => 50),
  getAllTimeConversionRate: vi.fn(() => ({ inquiriesCount: 0, confirmedCount: 0, totalCount: 0, conversionRate: 0 })),
  getCurrentYearStats: vi.fn(() => ({ year: 2026, totalBookings: 1, totalRevenue: 1, totalBookedDays: 1 })),
  getMonthlyBookingComparison: vi.fn(() => ({ currentMonth: 1, previousMonth: 1, change: 0 })),
}));
vi.mock('../repositories/reservation-repository.js', () => ({ getReservationsByPeriod: vi.fn(() => []) }));
vi.mock('../repositories/airbnb-payout-repository.js', () => ({ getEstimatedYearStats: vi.fn(() => ({ count: 0, revenue: 0 })) }));
vi.mock('../repositories/analytics-repository.js', () => ({
  getAnalyticsSummary: vi.fn(), hasAnalyticsData: vi.fn(() => false), getMonthlyAnalyticsComparison: vi.fn(),
  getTopRegions: vi.fn(), getAnalyticsRange: vi.fn(),
}));
vi.mock('../services/email-templates.js', () => ({ generateWeeklySummaryEmail: vi.fn(() => ({ html: '<p>x</p>', text: 'x' })) }));

const getActiveRecipientEmailsMock = vi.fn<(type: string, slug?: string) => string[]>();
vi.mock('../repositories/report-recipient-repository.js', () => ({
  getActiveRecipientEmails: (...a: [string, string?]) => getActiveRecipientEmailsMock(...a),
}));
const sendEmailMock = vi.fn(async (_o: unknown) => true);
vi.mock('../services/email-service.js', () => ({ sendEmail: (o: unknown) => sendEmailMock(o) }));

import { sendWeeklySummaryEmailForProperty } from './weekly-email.js';
import type { PropertyConfig } from '../config/properties.js';

const firenze = {
  slug: 'firenze-loft', name: 'Florenz', provider: 'guesty', guestyPropertyId: 'id-fi',
  timezone: 'Europe/Rome', currency: 'EUR', bookingRecipientEmail: 'b@e.com', bookingSenderName: 'X',
  weeklyReport: { enabled: true, recipients: ['alt@properties.json'], day: 1, hour: 6 },
  reportingUntil: '2026-11-23',
} as unknown as PropertyConfig;

beforeEach(() => {
  vi.clearAllMocks();
  getActiveRecipientEmailsMock.mockReturnValue(['a@x.de', 'b@x.de']);
});
afterEach(() => vi.useRealTimers());

describe('sendWeeklySummaryEmailForProperty (#1223)', () => {
  it('Empfänger aus der DB (weekly-summary + Slug), nicht aus properties.json', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T05:00:00Z'));
    const r = await sendWeeklySummaryEmailForProperty(firenze);
    expect(r).toMatchObject({ success: true, sent: true, recipientCount: 2 });
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('weekly-summary', 'firenze-loft');
    expect((sendEmailMock.mock.calls[0][0] as any).to).toEqual(['a@x.de', 'b@x.de']);
  });

  it('Florenz: Mo 23.11.2026 (Stichtag) wird noch versendet', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T05:00:00Z'));
    expect((await sendWeeklySummaryEmailForProperty(firenze)).sent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('Florenz: Mo 30.11.2026 wird nicht mehr versendet', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-30T05:00:00Z'));
    const r = await sendWeeklySummaryEmailForProperty(firenze);
    expect(r).toMatchObject({ success: true, sent: false });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('keine Empfänger: kein Versand, No recipients configured', async () => {
    getActiveRecipientEmailsMock.mockReturnValue([]);
    const r = await sendWeeklySummaryEmailForProperty({ ...firenze, reportingUntil: undefined });
    expect(r).toMatchObject({ success: true, sent: false, error: 'No recipients configured' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('enabled=false: kein Versand, keine DB-Abfrage', async () => {
    const r = await sendWeeklySummaryEmailForProperty({ ...firenze, weeklyReport: { ...firenze.weeklyReport, enabled: false } });
    expect(r.sent).toBe(false);
    expect(getActiveRecipientEmailsMock).not.toHaveBeenCalled();
  });
});
