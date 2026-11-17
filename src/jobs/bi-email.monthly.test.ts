/**
 * #1223: Portfolio wöchentlich/monatlich — Empfänger aus der DB, Florenz-Stichtag,
 * Berichtszeitraum Vormonat, getLeadTimeSamples nur über Reporting-Objekte.
 * sendEmail ist IMMER gemockt (kein echter Versand).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn(() => ({ title: 'T', nickname: null, currency: 'EUR' })),
}));
const getOccupancyBreakdownMock = vi.fn((..._a: unknown[]) => ({ bookedDays: 20, blockedDays: 3, sellableDays: 27, totalDays: 30, rate: 70 }));
const getOccupancyRateMock = vi.fn((..._a: unknown[]) => 55);
const getAvailabilityMock = vi.fn((..._a: unknown[]) => [] as Array<{ date: string; status: string }>);
vi.mock('../repositories/availability-repository.js', () => ({
  getAllTimeStats: vi.fn(() => ({ totalBookings: 40, totalRevenue: 30000, totalBookedDays: 200, startDate: '2025-07-01', endDate: '2026-06-02' })),
  getCurrentYearStats: vi.fn(() => ({ year: 2026, totalBookings: 20, totalRevenue: 15000, totalBookedDays: 100 })),
  getOccupancyRate: (...a: unknown[]) => getOccupancyRateMock(...a),
  getOccupancyBreakdown: (...a: unknown[]) => getOccupancyBreakdownMock(...a),
  getAvailability: (...a: unknown[]) => getAvailabilityMock(...a),
}));
const getReservationsInRangeMock = vi.fn((..._a: unknown[]) => [] as unknown[]);
const getLeadTimeSamplesMock = vi.fn((..._a: unknown[]) => Array.from({ length: 30 }, () => ({ checkIn: '2026-07-01', reservedAt: '2026-06-01' })));
const getRevenueMock = vi.fn((..._a: unknown[]) => 4000);
vi.mock('../repositories/reservation-repository.js', () => ({
  ACTIVE_RESERVATION_STATUSES: ['confirmed', 'reserved'],
  getReservationsByPeriod: vi.fn(() => []),
  getReservationsInRange: (...a: unknown[]) => getReservationsInRangeMock(...a),
  getLeadTimeSamples: (...a: unknown[]) => getLeadTimeSamplesMock(...a),
  getRevenueForCheckInMonth: (...a: unknown[]) => getRevenueMock(...a),
}));
vi.mock('../repositories/airbnb-mail-archive-repository.js', () => ({ getLastSyncAt: vi.fn(() => null) }));
vi.mock('../repositories/airbnb-payout-repository.js', () => ({
  getEstimatedYearStats: vi.fn(() => ({ count: 0, revenue: 0 })),
  getUnmatchedPayouts: vi.fn(() => []),
}));
vi.mock('./airbnb-mail/reconcile-ical.js', () => ({ findReservationsMissingInIcal: vi.fn(() => []) }));

const getActiveRecipientEmailsMock = vi.fn<(type: string, slug?: string) => string[]>();
vi.mock('../repositories/report-recipient-repository.js', () => ({
  getActiveRecipientEmails: (...a: [string, string?]) => getActiveRecipientEmailsMock(...a),
}));
const sendEmailMock = vi.fn(async (_o: unknown) => true);
vi.mock('../services/email-service.js', () => ({ sendEmail: (o: unknown) => sendEmailMock(o) }));

const prop = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug, name, provider: 'guesty', guestyPropertyId: `id-${slug}`,
  timezone: 'Europe/Berlin', currency: 'EUR',
  bookingRecipientEmail: 'b@e.com', bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: ['alt@properties.json'], day: 1, hour: 6 },
  ...extra,
});
let allProps: ReturnType<typeof prop>[];
let biEnabled = true;
vi.mock('../config/properties.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    getAllProperties: () => allProps,
    getBiReportConfig: () => ({ enabled: biEnabled, recipients: ['alt@biReport.json'], day: 1, hour: 6, timezone: 'Europe/Berlin', forecastHorizonMonths: 6 }),
  };
});

import { buildBiReportModel, getPreviousMonthPeriod, sendBiReportEmail, sendPortfolioMonthlyEmail } from './bi-email.js';

const berlin = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.clearAllMocks();
  biEnabled = true;
  allProps = [prop('farmhouse', 'Farmhouse'), prop('firenze-loft', 'Florenz', { reportingUntil: '2026-11-23' })];
  getActiveRecipientEmailsMock.mockReturnValue(['a@x.de']);
  getReservationsInRangeMock.mockReturnValue([]);
});
afterEach(() => vi.useRealTimers());

describe('getPreviousMonthPeriod', () => {
  it('01.12.2026 06:00 Berlin -> November 2026', () => {
    expect(getPreviousMonthPeriod(berlin('2026-12-01T05:00:00Z'))).toEqual({ start: '2026-11-01', endExclusive: '2026-12-01', label: 'November 2026' });
  });
  it('01.01.2027 -> Dezember 2026', () => {
    expect(getPreviousMonthPeriod(berlin('2027-01-01T05:00:00Z'))).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01', label: 'Dezember 2026' });
  });
  it('01.03.2026 -> Februar 2026', () => {
    expect(getPreviousMonthPeriod(berlin('2026-03-01T05:00:00Z'))).toEqual({ start: '2026-02-01', endExclusive: '2026-03-01', label: 'Februar 2026' });
  });
  it('Berliner Mitternacht: 30.11. 23:30Z ist schon der 01.12. in Berlin', () => {
    expect(getPreviousMonthPeriod(berlin('2026-11-30T23:30:00Z')).label).toBe('November 2026');
  });
});

describe('buildBiReportModel — Monatszeitraum', () => {
  const period = { start: '2026-10-01', endExclusive: '2026-11-01', label: 'Oktober 2026' };
  const res = (id: string, ci: string, co: string, status = 'confirmed') => ({
    reservation_id: id, check_in: ci, check_out: co, nights_count: 2, guest_name: 'Gast ' + id, guests_count: 2, source: 'direct', platform: null, status,
  });

  it('Kalender, Anreisen (alle, chronologisch, nur aktive im Zeitraum), KPI, Labels', () => {
    getReservationsInRangeMock.mockReturnValue([
      res('r9', '2026-10-28', '2026-11-02'),
      res('r1', '2026-09-29', '2026-10-03'), // Anreise vor Zeitraum
      res('r2', '2026-10-03', '2026-10-05'),
      res('r3', '2026-10-05', '2026-10-06'),
      res('r4', '2026-10-06', '2026-10-07'),
      res('r5', '2026-10-07', '2026-10-08'),
      res('r6', '2026-10-08', '2026-10-09'),
      res('r7', '2026-10-09', '2026-10-10'),
      res('rx', '2026-10-12', '2026-10-13', 'canceled'),
    ]);
    const model = buildBiReportModel([prop('farmhouse', 'Farmhouse')] as never, berlin('2026-11-01T05:00:00Z'), 6, { period });
    expect(model.calendar.startDate).toBe('2026-10-01');
    expect(model.calendar.dayCount).toBe(31);
    expect(model.weekLabel).toBe('Oktober 2026');
    expect(model.arrivals.map((a) => a.date)).toEqual(['2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-28']);
    expect(model.arrivals[1].isTurnover).toBe(true); // r2 reist 05.10. ab, r3 an
    expect(model.labels?.calendarHeading).toBe('① Übersichtskalender · Oktober 2026');
    expect(model.labels?.arrivalsHeading).toBe('② Anreisen &amp; Turnovers · Oktober 2026');
    // KPI: Belegung im Monat, Vormonat, Umsatz Monat/Vormonat
    expect(getOccupancyBreakdownMock).toHaveBeenCalledWith('id-farmhouse', '2026-10-01', '2026-10-31');
    expect(getOccupancyRateMock).toHaveBeenCalledWith('id-farmhouse', '2026-09-01', '2026-09-30');
    expect(getRevenueMock).toHaveBeenCalledWith('id-farmhouse', '2026-10');
    expect(getRevenueMock).toHaveBeenCalledWith('id-farmhouse', '2026-09');
    expect(getAvailabilityMock).toHaveBeenCalledWith('id-farmhouse', '2026-10-01', '2026-10-31');
  });

  it('ohne options: Wochenverhalten, kein labels-Feld', () => {
    const model = buildBiReportModel([prop('farmhouse', 'Farmhouse')] as never, berlin('2026-06-02T06:00:00Z'), 6);
    expect(model.labels).toBeUndefined();
    expect(model.calendar.dayCount).toBe(42);
  });
});

describe('getLeadTimeSamples nur über die Listings der übergebenen Properties', () => {
  it('übergibt die Listing-IDs (ohne Florenz)', () => {
    buildBiReportModel([prop('farmhouse', 'Farmhouse')] as never, berlin('2026-06-02T06:00:00Z'), 6);
    expect(getLeadTimeSamplesMock).toHaveBeenCalledWith(['id-farmhouse']);
  });
});

describe('sendBiReportEmail — Empfänger aus der DB, Florenz-Stichtag', () => {
  it('Empfänger kommen aus getActiveRecipientEmails, nicht aus properties.json', async () => {
    vi.useFakeTimers(); vi.setSystemTime(berlin('2026-11-23T05:00:00Z'));
    getActiveRecipientEmailsMock.mockReturnValue(['a@x.de', 'b@x.de']);
    const r = await sendBiReportEmail();
    expect(r.sent).toBe(true);
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('portfolio-weekly');
    expect((sendEmailMock.mock.calls[0][0] as any).to).toEqual(['a@x.de', 'b@x.de']);
  });

  it('keine Empfänger: kein Versand, error No recipients', async () => {
    getActiveRecipientEmailsMock.mockReturnValue([]);
    expect(await sendBiReportEmail()).toEqual({ success: true, sent: false, error: 'No recipients' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Florenz am 23.11. (Berlin) im Modell/in kpis, am 24.11. nicht', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(berlin('2026-11-23T05:00:00Z'));
    await sendBiReportEmail();
    expect((sendEmailMock.mock.calls[0][0] as any).html).toContain('Florenz');
    expect(getLeadTimeSamplesMock).toHaveBeenLastCalledWith(['id-farmhouse', 'id-firenze-loft']);

    vi.setSystemTime(berlin('2026-11-24T05:00:00Z'));
    await sendBiReportEmail();
    expect((sendEmailMock.mock.calls[1][0] as any).html).not.toContain('Florenz');
    expect(getLeadTimeSamplesMock).toHaveBeenLastCalledWith(['id-farmhouse']);
  });

  it('Häkchen entfernen wirkt ohne Neustart (kein Cache)', async () => {
    getActiveRecipientEmailsMock.mockReturnValueOnce(['a@x.de', 'b@x.de']).mockReturnValueOnce(['a@x.de']);
    await sendBiReportEmail();
    await sendBiReportEmail();
    expect((sendEmailMock.mock.calls[0][0] as any).to).toEqual(['a@x.de', 'b@x.de']);
    expect((sendEmailMock.mock.calls[1][0] as any).to).toEqual(['a@x.de']);
  });

  it('Betreff des Wochenreports unverändert', async () => {
    vi.useFakeTimers(); vi.setSystemTime(berlin('2026-06-02T06:00:00Z'));
    await sendBiReportEmail();
    expect((sendEmailMock.mock.calls[0][0] as any).subject).toBe('📊 AirBnB Portfolio Report · 2. Jun 2026');
  });
});

describe('sendPortfolioMonthlyEmail', () => {
  it('Betreff mit Monat/Jahr, Empfänger portfolio-monthly, Monatslabels im HTML', async () => {
    const r = await sendPortfolioMonthlyEmail(berlin('2026-12-01T05:00:00Z'));
    expect(r).toEqual({ success: true, sent: true });
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('portfolio-monthly');
    const mail = sendEmailMock.mock.calls[0][0] as any;
    expect(mail.subject).toBe('📊 AirBnB Portfolio Report · Monat November 2026');
    expect(mail.to).toEqual(['a@x.de']);
    expect(mail.html).toContain('② Anreisen &amp; Turnovers · November 2026');
  });

  it('Florenz am 01.12. nicht mehr dabei', async () => {
    await sendPortfolioMonthlyEmail(berlin('2026-12-01T05:00:00Z'));
    const mail = sendEmailMock.mock.calls[0][0] as any;
    expect(mail.html).not.toContain('Florenz');
    expect(mail.html).toContain('Farmhouse');
  });

  it('Florenz am 23.11. (Stichtag) noch im Modell', async () => {
    await sendPortfolioMonthlyEmail(berlin('2026-11-23T05:00:00Z'));
    expect((sendEmailMock.mock.calls[0][0] as any).html).toContain('Florenz');
  });

  it('keine Empfänger -> kein Versand', async () => {
    getActiveRecipientEmailsMock.mockReturnValue([]);
    expect((await sendPortfolioMonthlyEmail(berlin('2026-12-01T05:00:00Z'))).sent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('biReport.enabled=false -> kein Versand', async () => {
    biEnabled = false;
    expect((await sendPortfolioMonthlyEmail(berlin('2026-12-01T05:00:00Z'))).sent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Versandfehler -> sent:false', async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect((await sendPortfolioMonthlyEmail(berlin('2026-12-01T05:00:00Z'))).sent).toBe(false);
  });
});
