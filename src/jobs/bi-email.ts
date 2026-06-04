/**
 * Portfolio BI Email Job
 *
 * Gathers data across ALL properties, builds a BiReportModel and sends one
 * consolidated weekly email. Complements the per-property weekly reports.
 */
import { addDays, addMonths, format, getDay, getHours, startOfMonth, differenceInCalendarDays, differenceInCalendarMonths, getDaysInMonth } from 'date-fns';
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
  getOccupancyBreakdown,
  getAvailability,
} from '../repositories/availability-repository.js';
import {
  getReservationsByPeriod,
  getReservationsInRange,
  getLeadTimeSamples,
  getRevenueForCheckInMonth,
} from '../repositories/reservation-repository.js';
import { buildGanttGrid } from '../services/bi-calendar.js';
import { buildLeadTimeCurve, forecastMonthRevenue, type RevenueForecast, type ForecastConfidence } from '../services/forecast.js';
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
  // Reservations overlapping the 42-day calendar window — includes stays that
  // checked in BEFORE today, so same-day turnovers on `today` are detected.
  windowReservations: ReturnType<typeof getReservationsInRange>;
  sampleN: number;
  listingStart: string | null;
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
      const breakdown6wk = getOccupancyBreakdown(listingId, today, in6Weeks);
      const occ6wk = breakdown6wk.rate;
      const blockedDays6wk = breakdown6wk.blockedDays;
      const occ30d = getOccupancyRate(listingId, last30, today);
      const revMonth = getRevenueForCheckInMonth(listingId, curMonth);
      const revPrev = getRevenueForCheckInMonth(listingId, prevMonth);
      const changePct = revPrev > 0 ? Math.round(((revMonth - revPrev) / revPrev) * 100) : revMonth > 0 ? 100 : 0;
      const adr = currentYear.totalBookedDays > 0 ? currentYear.totalRevenue / currentYear.totalBookedDays : 0;

      // 'future' ignores the days arg (no upper bound) — returns all upcoming
      // check-ins, used for the next-5 arrivals list.
      const futureReservations = getReservationsByPeriod(listingId, 0, 'future');
      // Stays overlapping the calendar window (incl. in-progress) for the Gantt
      // and same-day turnover detection.
      const windowReservations = getReservationsInRange(listingId, today, in6Weeks);

      collected.push({
        property,
        listingId,
        futureReservations,
        windowReservations,
        sampleN: allTime.totalBookings,
        listingStart: allTime.startDate,
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
          blockedDays6wk,
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
      reservations: c.windowReservations.map((r) => ({ check_in: r.check_in, check_out: r.check_out })),
    })),
  });

  // Next 5 arrivals portfolio-wide
  const arrivals: UpcomingArrival[] = collected
    .flatMap((c) => {
      // Checkouts from window stays (incl. in-progress) so an arrival on a day
      // that also has a departure is flagged as a turnover.
      const checkOuts = new Set(c.windowReservations.map((r) => r.check_out.slice(0, 10)));
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

  // ----- Forecast v2 (revenue, layered: historical > pickup > rampup) -----
  const biForecast = getBiReportConfig()?.forecast ?? { rampMonths: 12, steadyOccupancyPct: 0.6 };
  const adrs = collected.map((c) => c.kpi.adr).filter((a) => a > 0);
  const portfolioAvgAdr = adrs.length ? adrs.reduce((s, a) => s + a, 0) / adrs.length : 100;
  const months = Array.from({ length: horizonMonths }, (_, i) => addMonths(now, i));

  // per property: a RevenueForecast per month
  const perProperty = collected.map((c) => {
    const listingStart = c.listingStart ? new Date(c.listingStart) : null;
    const rampMonths = c.property.static?.rampMonths ?? biForecast.rampMonths;
    const steadyOccupancyPct = c.property.static?.steadyOccupancyPct ?? biForecast.steadyOccupancyPct;
    const adr = c.kpi.adr > 0 ? c.kpi.adr : c.property.static?.basePrice ?? portfolioAvgAdr;

    const monthsFc: RevenueForecast[] = months.map((m) => {
      const mStart = startOfMonth(m);
      const committed = getRevenueForCheckInMonth(c.listingId, format(mStart, 'yyyy-MM'));
      const priorStart = startOfMonth(addMonths(mStart, -12));
      const active = listingStart !== null && listingStart.getTime() <= priorStart.getTime();
      const priorYearRevenue = active ? getRevenueForCheckInMonth(c.listingId, format(priorStart, 'yyyy-MM')) : null;
      const priorYearsAvailable =
        priorYearRevenue !== null ? Math.max(1, mStart.getFullYear() - (listingStart as Date).getFullYear()) : 0;
      const monthsSinceStart = listingStart ? differenceInCalendarMonths(mStart, listingStart) : null;
      return forecastMonthRevenue({
        monthLabel: format(m, 'MMM'),
        committedRevenue: committed,
        daysUntilMidpoint: daysUntilMidpoint(m, now),
        daysInMonth: getDaysInMonth(m),
        monthsSinceStart,
        priorYearRevenue,
        priorYearsAvailable,
        growth: 1.0, // YoY growth not yet computable (<13 months history); flat baseline
        adr,
        rampMonths,
        steadyOccupancyPct,
        curve,
        propertySampleN: c.sampleN,
      });
    });
    return { c, monthsFc };
  });

  const propertyForecasts: PropertyForecast[] = perProperty.map(({ c, monthsFc }) => ({
    slug: c.property.slug,
    name: c.property.name,
    committedTotal: Math.round(monthsFc.reduce((s, m) => s + m.committedRevenue, 0)),
    expectedTotal: Math.round(monthsFc.reduce((s, m) => s + m.expectedRevenue, 0)),
    highTotal: Math.round(monthsFc.reduce((s, m) => s + m.highRevenue, 0)),
    confidence: worstConfidence(monthsFc),
    methodLabel: dominantMethodLabel(monthsFc),
    months: monthsFc,
  }));

  const portfolioForecast: RevenueForecast[] = months.map((m, idx) => {
    const col = perProperty.map((pp) => pp.monthsFc[idx]);
    const expected = col.reduce((s, x) => s + x.expectedRevenue, 0);
    return {
      monthLabel: format(m, 'MMM'),
      committedRevenue: Math.round(col.reduce((s, x) => s + x.committedRevenue, 0)),
      expectedRevenue: Math.round(expected),
      lowRevenue: Math.round(col.reduce((s, x) => s + x.lowRevenue, 0)),
      highRevenue: Math.round(col.reduce((s, x) => s + x.highRevenue, 0)),
      confidence: portfolioMonthConfidence(col),
      method: dominantMethod(col),
      isOpen: expected < 1,
    };
  });

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
      blockedDays6wk: collected.reduce((s, c) => s + c.kpi.blockedDays6wk, 0),
    },
    calendar,
    arrivals,
    kpis: collected.map((c) => c.kpi),
    portfolioForecast,
    propertyForecasts,
  };
}

function getAvailabilitySafe(listingId: string, start: string, end: string) {
  // getAvailability returns full Availability rows; the grid only needs date+status.
  return getAvailability(listingId, start, end).map((a) => ({ date: a.date, status: a.status }));
}

function daysUntilMidpoint(monthDate: Date, now: Date): number {
  const mid = addDays(startOfMonth(monthDate), 14);
  return Math.max(0, differenceInCalendarDays(mid, now));
}

const METHOD_LABELS: Record<RevenueForecast['method'], string> = {
  historical: 'Vorjahr',
  pickup: 'Buchungsvorlauf',
  rampup: 'Ramp-up (Anlauf)',
};
const CONF_RANK: Record<ForecastConfidence, number> = { niedrig: 0, mittel: 1, hoch: 2 };

function worstConfidence(months: RevenueForecast[]): ForecastConfidence {
  return months.reduce<ForecastConfidence>(
    (worst, m) => (CONF_RANK[m.confidence] < CONF_RANK[worst] ? m.confidence : worst),
    'hoch'
  );
}

function dominantMethod(months: RevenueForecast[]): RevenueForecast['method'] {
  const byMethod = new Map<RevenueForecast['method'], number>();
  for (const m of months) byMethod.set(m.method, (byMethod.get(m.method) ?? 0) + m.expectedRevenue);
  let best: RevenueForecast['method'] = 'pickup';
  let bestVal = -1;
  for (const [method, val] of byMethod) if (val > bestVal) { best = method; bestVal = val; }
  return best;
}

function dominantMethodLabel(months: RevenueForecast[]): string {
  const dom = dominantMethod(months);
  const label = METHOD_LABELS[dom];
  return months.every((m) => m.method === dom) ? label : `überw. ${label}`;
}

function portfolioMonthConfidence(col: RevenueForecast[]): ForecastConfidence {
  const total = col.reduce((s, x) => s + x.expectedRevenue, 0);
  if (total <= 0) return 'niedrig';
  const hochShare = col.filter((x) => x.confidence === 'hoch').reduce((s, x) => s + x.expectedRevenue, 0) / total;
  const hochMittelShare =
    col.filter((x) => x.confidence === 'hoch' || x.confidence === 'mittel').reduce((s, x) => s + x.expectedRevenue, 0) / total;
  if (hochShare >= 0.6) return 'hoch';
  if (hochMittelShare >= 0.6) return 'mittel';
  return 'niedrig';
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
      subject: `📊 AirBnB Portfolio Report · ${model.weekLabel}`,
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
