/**
 * Weekly Email Job
 *
 * Sends a weekly summary email with dashboard statistics and upcoming bookings
 */

import { config } from '../config/index.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getAllTimeStats, getOccupancyRate, getAllTimeConversionRate } from '../repositories/availability-repository.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
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
}

/**
 * Send weekly summary email
 */
export async function sendWeeklySummaryEmail(): Promise<WeeklyEmailResult> {
  try {
    // Check if weekly report is enabled
    if (!config.weeklyReportEnabled) {
      logger.debug('Weekly report is disabled');
      return {
        success: true,
        sent: false,
      };
    }

    // Check if recipients are configured
    if (!config.weeklyReportRecipients || config.weeklyReportRecipients.length === 0) {
      logger.warn('Weekly report enabled but no recipients configured');
      return {
        success: true,
        sent: false,
        error: 'No recipients configured',
      };
    }

    logger.info('📧 Starting weekly summary email job');

    const propertyId = config.guestyPropertyId;

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

    // Get next 5 upcoming bookings
    const allUpcomingBookings = getReservationsByPeriod(propertyId, 365, 'future');
    const upcomingBookings = allUpcomingBookings.slice(0, 5);

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
      occupancyRates: {
        next4Weeks: occupancyNext4Weeks,
        last3Months: occupancyLast3Months,
      },
      conversionRate: {
        inquiries: conversionData.inquiriesCount,
        confirmed: conversionData.confirmedCount,
        rate: conversionData.conversionRate,
      },
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
      to: config.weeklyReportRecipients,
      subject: `📊 Weekly Summary - ${emailData.propertyTitle}`,
      html,
      text,
    });

    if (sent) {
      logger.info(
        {
          recipientCount: config.weeklyReportRecipients.length,
          recipients: config.weeklyReportRecipients,
          upcomingBookings: upcomingBookings.length,
          allTimeRevenue: allTimeStats.totalRevenue,
        },
        '✅ Weekly summary email sent successfully'
      );

      return {
        success: true,
        sent: true,
        recipientCount: config.weeklyReportRecipients.length,
      };
    } else {
      logger.error('Failed to send weekly summary email');
      return {
        success: false,
        sent: false,
        error: 'Email sending failed',
      };
    }
  } catch (error) {
    logger.error({ error }, '❌ Weekly email job failed');
    return {
      success: false,
      sent: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if weekly email should be sent today
 * Returns true if today matches the configured day and current hour matches configured hour
 * Uses the property's timezone (Europe/Berlin) to ensure correct scheduling
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
