/**
 * Portfolio BI Email Job
 *
 * Gathers data across ALL properties, builds a BiReportModel and sends one
 * consolidated weekly email. Complements the per-property weekly reports.
 */
import { addDays, addMonths, format, getDay, getHours, startOfMonth, endOfMonth, differenceInCalendarDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  getAllProperties,
  getBiReportConfig,
  getListingId,
  type PropertyConfig,
} from '../config/properties.js';
import { getListingById } from '../repositories/listings-repository.js';
import {
  getAllTimeStats,
  getCurrentYearStats,
  getOccupancyRate,
  getOccupancyCounts,
  getAvailability,
} from '../repositories/availability-repository.js';
import {
  getReservationsByPeriod,
  getLeadTimeSamples,
  getRevenueForCheckInMonth,
} from '../repositories/reservation-repository.js';
import { buildGanttGrid } from '../services/bi-calendar.js';
import { buildLeadTimeCurve, forecastMonth, type MonthForecast } from '../services/forecast.js';
import { generateBiReportEmail } from '../services/bi-email-templates.js';
import { sendEmail } from '../services/email-service.js';
import type { BiReportModel, PropertyKpi, UpcomingArrival, PropertyForecast } from '../types/bi-report.js';
import logger from '../utils/logger.js';

const CALENDAR_DAYS = 42;
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

interface PropertyData {
  property: PropertyConfig;
  listingId: string;
  futureReservations: ReturnType<typeof getReservationsByPeriod>;
  sampleN: number;
  kpi: PropertyKpi;
}

/** Build the full report model. All DB I/O is via the imported repos. */
export function buildBiReportModel(
  properties: PropertyConfig[],
  now: Date,
  horizonMonths: number
): BiReportModel {
  const today = ymd(now);
  const in6Weeks = ymd(addDays(now, CALENDAR_DAYS));
  const last30 = ymd(addDays(now, -30));
  const curMonth = format(now, 'yyyy-MM');
  const prevMonth = format(addMonths(now, -1), 'yyyy-MM');

  // Pooled lead-time curve across the whole portfolio
  const curve = buildLeadTimeCurve(getLeadTimeSamples());

  const collected: PropertyData[] = [];

  for (const property of properties) {
    try {
      const listingId = getListingId(property);
      const listing = getListingById(listingId);
      if (!listing) {
        logger.warn({ propertySlug: property.slug }, 'BI report: listing not found, skipping');
        continue;
      }

      const allTime = getAllTimeStats(listingId);
      const currentYear = getCurrentYearStats(listingId);
      const occ6wk = getOccupancyRate(listingId, today, in6Weeks);
      const occ30d = getOccupancyRate(listingId, last30, today);
      const revMonth = getRevenueForCheckInMonth(listingId, curMonth);
      const revPrev = getRevenueForCheckInMonth(listingId, prevMonth);
      const changePct = revPrev > 0 ? Math.round(((revMonth - revPrev) / revPrev) * 100) : revMonth > 0 ? 100 : 0;
      const adr = currentYear.totalBookedDays > 0 ? currentYear.totalRevenue / currentYear.totalBookedDays : 0;

      const futureReservations = getReservationsByPeriod(listingId, 365, 'future');

      collected.push({
        property,
        listingId,
        futureReservations,
        sampleN: allTime.totalBookings,
        kpi: {
          slug: property.slug,
          name: property.name,
          occupancy6wk: occ6wk,
          occupancy30d: occ30d,
          revenueYtd: currentYear.totalRevenue,
          revenueMonth: revMonth,
          revenueChangePct: changePct,
          bookingsYtd: currentYear.totalBookings,
          adr,
          currency: listing.currency || property.currency || 'EUR',
        },
      });
    } catch (error) {
      logger.error({ error, propertySlug: property.slug }, 'BI report: failed to gather property data, skipping');
    }
  }

  // Calendar grid
  const calendar = buildGanttGrid({
    startDate: today,
    dayCount: CALENDAR_DAYS,
    properties: collected.map((c) => ({
      slug: c.property.slug,
      name: c.property.name,
      availability: getAvailabilitySafe(c.listingId, today, in6Weeks),
      reservations: c.futureReservations.map((r) => ({ check_in: r.check_in, check_out: r.check_out })),
    })),
  });

  // Next 5 arrivals portfolio-wide
  const arrivals: UpcomingArrival[] = collected
    .flatMap((c) => {
      const checkOuts = new Set(c.futureReservations.map((r) => r.check_out.slice(0, 10)));
      return c.futureReservations.map((r) => ({
        date: r.check_in.slice(0, 10),
        propertySlug: c.property.slug,
        propertyName: c.property.name,
        guestName: r.guest_name || 'Unbekannt',
        nights: r.nights_count || 0,
        guests: r.guests_count || 0,
        source: r.source || r.platform || 'Unbekannt',
        isTurnover: checkOuts.has(r.check_in.slice(0, 10)),
      }));
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  // Forecast per month (portfolio + per property)
  const months = Array.from({ length: horizonMonths }, (_, i) => addMonths(now, i));

  const portfolioForecast = months.map((m) =>
    forecastMonthAcross(collected.map((c) => c.listingId), m, now, curve, sumSampleN(collected))
  );

  const propertyForecasts: PropertyForecast[] = collected.map((c) => ({
    slug: c.property.slug,
    name: c.property.name,
    lowData: c.sampleN < 15 || curve.n < 20,
    months: months.map((m) => forecastMonthForListing(c.listingId, m, now, curve, c.sampleN)),
  }));

  const committedRevenueHorizon = portfolioForecast.reduce((s, m) => s + m.committedRevenue, 0);
  const avgOccupancy6wk = collected.length
    ? Math.round(collected.reduce((s, c) => s + c.kpi.occupancy6wk, 0) / collected.length)
    : 0;

  return {
    generatedAt: now.toISOString(),
    weekLabel: format(now, 'd. MMM yyyy'),
    currency: collected[0]?.kpi.currency || 'EUR',
    portfolio: {
      revenueYtd: collected.reduce((s, c) => s + c.kpi.revenueYtd, 0),
      avgOccupancy6wk,
      bookingsYtd: collected.reduce((s, c) => s + c.kpi.bookingsYtd, 0),
      committedRevenueHorizon,
    },
    calendar,
    arrivals,
    kpis: collected.map((c) => c.kpi),
    portfolioForecast,
    propertyForecasts,
  };
}

function sumSampleN(collected: PropertyData[]): number {
  return collected.reduce((s, c) => s + c.sampleN, 0);
}

function getAvailabilitySafe(listingId: string, start: string, end: string) {
  // getAvailability returns full Availability rows; the grid only needs date+status.
  return getAvailability(listingId, start, end).map((a) => ({ date: a.date, status: a.status }));
}

function monthOccAndRevenue(listingId: string, monthDate: Date) {
  const start = ymd(startOfMonth(monthDate));
  const endExclusive = ymd(addDays(endOfMonth(monthDate), 1));
  const counts = getOccupancyCounts(listingId, start, endExclusive);
  const revenue = getRevenueForCheckInMonth(listingId, format(monthDate, 'yyyy-MM'));
  return { counts, revenue };
}

function daysUntilMidpoint(monthDate: Date, now: Date): number {
  const mid = addDays(startOfMonth(monthDate), 14);
  return Math.max(0, differenceInCalendarDays(mid, now));
}

function forecastMonthForListing(
  listingId: string,
  monthDate: Date,
  now: Date,
  curve: ReturnType<typeof buildLeadTimeCurve>,
  sampleN: number
): MonthForecast {
  const { counts, revenue } = monthOccAndRevenue(listingId, monthDate);
  return forecastMonth({
    monthLabel: format(monthDate, 'MMM'),
    otbNights: counts.occupiedDays,
    capacityNights: counts.totalDays,
    otbRevenue: revenue,
    daysUntilMidpoint: daysUntilMidpoint(monthDate, now),
    curve,
    propertySampleN: sampleN,
  });
}

function forecastMonthAcross(
  listingIds: string[],
  monthDate: Date,
  now: Date,
  curve: ReturnType<typeof buildLeadTimeCurve>,
  sampleN: number
): MonthForecast {
  let otbNights = 0;
  let capacityNights = 0;
  let otbRevenue = 0;
  for (const id of listingIds) {
    const { counts, revenue } = monthOccAndRevenue(id, monthDate);
    otbNights += counts.occupiedDays;
    capacityNights += counts.totalDays;
    otbRevenue += revenue;
  }
  return forecastMonth({
    monthLabel: format(monthDate, 'MMM'),
    otbNights,
    capacityNights,
    otbRevenue,
    daysUntilMidpoint: daysUntilMidpoint(monthDate, now),
    curve,
    propertySampleN: sampleN,
  });
}

/** Send the consolidated BI report email. */
export async function sendBiReportEmail(): Promise<{ success: boolean; sent: boolean; error?: string }> {
  const biConfig = getBiReportConfig();
  if (!biConfig || !biConfig.enabled) {
    logger.debug('BI report disabled or not configured');
    return { success: true, sent: false };
  }
  if (!biConfig.recipients.length) {
    logger.warn('BI report enabled but no recipients configured');
    return { success: true, sent: false, error: 'No recipients' };
  }

  try {
    const properties = getAllProperties();
    const model = buildBiReportModel(properties, new Date(), biConfig.forecastHorizonMonths);
    const { html, text } = generateBiReportEmail(model);

    const sent = await sendEmail({
      to: biConfig.recipients,
      subject: `📊 Portfolio-Report · ${model.weekLabel}`,
      html,
      text,
    });

    if (sent) {
      logger.info({ recipients: biConfig.recipients.length, properties: model.kpis.length }, '✅ BI report email sent');
      return { success: true, sent: true };
    }
    return { success: false, sent: false, error: 'Email sending failed' };
  } catch (error) {
    logger.error({ error }, '❌ BI report email job failed');
    return { success: false, sent: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/** True when the configured day+hour matches now in the report timezone. */
export function shouldSendBiReport(): boolean {
  const biConfig = getBiReportConfig();
  if (!biConfig || !biConfig.enabled) return false;
  const zoned = toZonedTime(new Date(), biConfig.timezone);
  return getDay(zoned) === biConfig.day && getHours(zoned) === biConfig.hour;
}
