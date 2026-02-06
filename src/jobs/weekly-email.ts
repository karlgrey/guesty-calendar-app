/**
 * Weekly Email Job
 *
 * Sends a weekly summary email with dashboard statistics and upcoming bookings.
 * Supports multi-property mode with per-property email settings.
 */

import { config } from '../config/index.js';
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getAllTimeStats, getOccupancyRate, getAllTimeConversionRate, getCurrentYearStats, getMonthlyBookingComparison } from '../repositories/availability-repository.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import { getAnalyticsSummary, hasAnalyticsData, getMonthlyAnalyticsComparison, getTopRegions, getAnalyticsRange } from '../repositories/analytics-repository.js';
import { sendEmail } from '../services/email-service.js';
import { generateWeeklySummaryEmail } from '../services/email-templates.js';
import logger from '../utils/logger.js';
import { toZonedTime } from 'date-fns-tz';
import { getHours, getDay, addDays, addMonths, format } from 'date-fns';

interface WeeklyEmailResult {
  success: boolean;
  sent: boolean;
  error?: string;
  recipientCount?: number;
  propertySlug?: string;
}

/**
 * Send weekly summary email for a specific property
 */
export async function sendWeeklySummaryEmailForProperty(property: PropertyConfig): Promise<WeeklyEmailResult> {
  const { slug, guestyPropertyId, name, weeklyReport, ga4 } = property;

  try {
    // Check if weekly report is enabled for this property
    if (!weeklyReport.enabled) {
      logger.debug({ propertySlug: slug }, 'Weekly report is disabled for this property');
      return {
        success: true,
        sent: false,
        propertySlug: slug,
      };
    }

    // Check if recipients are configured
    if (!weeklyReport.recipients || weeklyReport.recipients.length === 0) {
      logger.warn({ propertySlug: slug }, 'Weekly report enabled but no recipients configured');
      return {
        success: true,
        sent: false,
        error: 'No recipients configured',
        propertySlug: slug,
      };
    }

    logger.info({ propertySlug: slug, propertyName: name }, '📧 Starting weekly summary email job');

    const propertyId = guestyPropertyId;

    // Get listing info
    const listing = getListingById(propertyId);
    if (!listing) {
      logger.error({ propertyId }, 'Listing not found');
      return {
        success: false,
        sent: false,
        error: 'Listing not found',
      };
    }

    // Get all-time statistics
    const allTimeStats = getAllTimeStats(propertyId);

    // Calculate occupancy rates
    const today = new Date();
    const fourWeeksFromNow = addDays(today, 28);
    const threeMonthsAgo = addMonths(today, -3);

    const occupancyNext4Weeks = getOccupancyRate(
      propertyId,
      format(today, 'yyyy-MM-dd'),
      format(fourWeeksFromNow, 'yyyy-MM-dd')
    );

    const occupancyLast3Months = getOccupancyRate(
      propertyId,
      format(threeMonthsAgo, 'yyyy-MM-dd'),
      format(today, 'yyyy-MM-dd')
    );

    // Calculate all-time conversion rate
    const conversionData = getAllTimeConversionRate(propertyId);

    // Get current year stats
    const currentYearStats = getCurrentYearStats(propertyId);

    // Get monthly booking comparison
    const bookingComparison = getMonthlyBookingComparison(propertyId);

    // Get next 5 upcoming bookings
    const allUpcomingBookings = getReservationsByPeriod(propertyId, 365, 'future');
    const upcomingBookings = allUpcomingBookings.slice(0, 5);

    // Get website analytics if GA4 is enabled for this property and has data
    let websiteAnalytics = undefined;
    if (ga4?.enabled && hasAnalyticsData()) {
      const analyticsSummary = getAnalyticsSummary(30);
      const monthlyComparison = getMonthlyAnalyticsComparison();
      const topRegions = getTopRegions(30);

      // Get daily data for last 30 days vs 30 days before that
      const formatDateStr = (d: Date) => d.toISOString().split('T')[0];

      const last30End = today;
      const last30Start = new Date(today);
      last30Start.setDate(last30Start.getDate() - 29); // 30 days including today

      const prev30End = new Date(last30Start);
      prev30End.setDate(prev30End.getDate() - 1); // Day before last30Start
      const prev30Start = new Date(prev30End);
      prev30Start.setDate(prev30Start.getDate() - 29); // 30 days

      const last30Data = getAnalyticsRange(formatDateStr(last30Start), formatDateStr(last30End));
      const prev30Data = getAnalyticsRange(formatDateStr(prev30Start), formatDateStr(prev30End));

      websiteAnalytics = {
        enabled: true,
        uniqueVisitors: analyticsSummary.totalUsers,
        pageviews: analyticsSummary.totalPageviews,
        sessions: analyticsSummary.totalSessions,
        monthlyComparison,
        topRegions,
        trendData: {
          currentMonth: last30Data.map(d => ({ date: d.date, users: d.users, pageviews: d.pageviews })),
          previousMonth: prev30Data.map(d => ({ date: d.date, users: d.users, pageviews: d.pageviews })),
          currentMonthLabel: 'Last 30 Days',
          previousMonthLabel: 'Previous 30 Days',
        },
      };
    }

    // Prepare data for email template
    const emailData = {
      propertyTitle: listing.nickname || listing.title,
      currency: listing.currency || 'EUR',
      allTimeStats: {
        total_bookings: allTimeStats.totalBookings,
        total_revenue: allTimeStats.totalRevenue,
        total_booked_days: allTimeStats.totalBookedDays,
        start_date: allTimeStats.startDate,
        end_date: allTimeStats.endDate,
      },
      currentYearStats: {
        year: currentYearStats.year,
        total_bookings: currentYearStats.totalBookings,
        total_revenue: currentYearStats.totalRevenue,
        total_booked_days: currentYearStats.totalBookedDays,
      },
      bookingComparison: {
        currentMonth: bookingComparison.currentMonth,
        previousMonth: bookingComparison.previousMonth,
        change: bookingComparison.change,
      },
      occupancyRates: {
        next4Weeks: occupancyNext4Weeks,
        last3Months: occupancyLast3Months,
      },
      conversionRate: {
        inquiries: conversionData.inquiriesCount,
        confirmed: conversionData.confirmedCount,
        total: conversionData.totalCount,
        rate: conversionData.conversionRate,
      },
      websiteAnalytics,
      upcomingBookings: upcomingBookings.map(r => ({
        reservationId: r.reservation_id,
        checkIn: r.check_in,
        checkOut: r.check_out,
        nights: r.nights_count,
        guestName: r.guest_name || 'Unknown Guest',
        guestsCount: r.guests_count || 0,
        status: r.status,
        confirmationCode: r.confirmation_code || undefined,
        source: r.source || r.platform || 'Unknown',
        totalPrice: r.host_payout || r.total_price || 0,
        plannedArrival: r.planned_arrival || undefined,
        plannedDeparture: r.planned_departure || undefined,
      })),
    };

    // Generate email content
    const { html, text } = generateWeeklySummaryEmail(emailData);

    // Send email
    const sent = await sendEmail({
      to: weeklyReport.recipients,
      subject: `📊 Weekly Summary - ${emailData.propertyTitle}`,
      html,
      text,
    });

    if (sent) {
      logger.info(
        {
          propertySlug: slug,
          recipientCount: weeklyReport.recipients.length,
          recipients: weeklyReport.recipients,
          upcomingBookings: upcomingBookings.length,
          allTimeRevenue: allTimeStats.totalRevenue,
        },
        `✅ Weekly summary email sent successfully for ${name}`
      );

      return {
        success: true,
        sent: true,
        recipientCount: weeklyReport.recipients.length,
        propertySlug: slug,
      };
    } else {
      logger.error({ propertySlug: slug }, 'Failed to send weekly summary email');
      return {
        success: false,
        sent: false,
        error: 'Email sending failed',
        propertySlug: slug,
      };
    }
  } catch (error) {
    logger.error({ error, propertySlug: slug }, `❌ Weekly email job failed for ${name}`);
    return {
      success: false,
      sent: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      propertySlug: slug,
    };
  }
}

/**
 * Send weekly summary email (legacy function for backward compatibility)
 * Uses global config settings
 */
export async function sendWeeklySummaryEmail(): Promise<WeeklyEmailResult> {
  // Try multi-property mode first
  const properties = getAllProperties();
  if (properties.length > 0) {
    // In multi-property mode, this function shouldn't be called directly
    // The scheduler calls sendWeeklySummaryEmailForProperty for each property
    // But for backward compatibility, send for the first property
    const property = properties[0];
    return sendWeeklySummaryEmailForProperty(property);
  }

  // Legacy single-property mode using global config
  if (!config.guestyPropertyId) {
    return {
      success: false,
      sent: false,
      error: 'No property configured',
    };
  }

  // Create legacy property config from global settings
  const legacyProperty: PropertyConfig = {
    slug: 'default',
    guestyPropertyId: config.guestyPropertyId,
    name: 'Default Property',
    timezone: config.propertyTimezone,
    currency: config.propertyCurrency,
    bookingRecipientEmail: config.bookingRecipientEmail,
    bookingSenderName: config.bookingSenderName,
    weeklyReport: {
      enabled: config.weeklyReportEnabled as boolean,
      recipients: config.weeklyReportRecipients as string[],
      day: config.weeklyReportDay,
      hour: config.weeklyReportHour,
    },
    ga4: {
      enabled: config.ga4Enabled as boolean,
      propertyId: config.ga4PropertyId,
      keyFilePath: config.ga4KeyFilePath,
      syncHour: config.ga4SyncHour,
    },
  };

  return sendWeeklySummaryEmailForProperty(legacyProperty);
}

/**
 * Check if weekly email should be sent for a specific property
 * Returns true if today matches the configured day and current hour matches configured hour
 * Uses the property's timezone to ensure correct scheduling
 */
export function shouldSendWeeklyEmailForProperty(property: PropertyConfig): boolean {
  const { slug, timezone, weeklyReport } = property;

  if (!weeklyReport.enabled) {
    return false;
  }

  // Get current time in the property's timezone
  const now = new Date();
  const propertyTime = toZonedTime(now, timezone);

  const currentDay = getDay(propertyTime); // 0 = Sunday, 1 = Monday, etc.
  const currentHour = getHours(propertyTime);

  logger.debug(
    {
      propertySlug: slug,
      utcTime: now.toISOString(),
      propertyTime: propertyTime.toISOString(),
      currentDay,
      currentHour,
      targetDay: weeklyReport.day,
      targetHour: weeklyReport.hour,
      timezone,
    },
    'Checking weekly email schedule for property'
  );

  return (
    currentDay === weeklyReport.day &&
    currentHour === weeklyReport.hour
  );
}

/**
 * Check if weekly email should be sent today (legacy function)
 * Uses global config settings
 */
export function shouldSendWeeklyEmail(): boolean {
  // Get current time in the property's timezone
  const now = new Date();
  const propertyTime = toZonedTime(now, config.propertyTimezone);

  const currentDay = getDay(propertyTime); // 0 = Sunday, 1 = Monday, etc.
  const currentHour = getHours(propertyTime);

  logger.debug(
    {
      utcTime: now.toISOString(),
      propertyTime: propertyTime.toISOString(),
      currentDay,
      currentHour,
      targetDay: config.weeklyReportDay,
      targetHour: config.weeklyReportHour,
      timezone: config.propertyTimezone,
    },
    'Checking weekly email schedule'
  );

  return (
    currentDay === config.weeklyReportDay &&
    currentHour === config.weeklyReportHour
  );
}
