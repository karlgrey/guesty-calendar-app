/**
 * Weekly Email Job
 *
 * Sends a weekly summary email with dashboard statistics and upcoming bookings
 */

import { config } from '../config/index.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getDashboardStats, getAllTimeStats } from '../repositories/availability-repository.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import { sendEmail } from '../services/email-service.js';
import { generateWeeklySummaryEmail } from '../services/email-templates.js';
import logger from '../utils/logger.js';

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

    // Get future stats (next 365 days)
    const futureStats = getDashboardStats(propertyId, 365, 'future');

    // Get upcoming bookings (next 365 days)
    const upcomingBookings = getReservationsByPeriod(propertyId, 365, 'future');

    // Get past stats (last 365 days)
    const pastStats = getDashboardStats(propertyId, 365, 'past');

    // Get all past bookings (last 365 days)
    const pastBookings = getReservationsByPeriod(propertyId, 365, 'past');

    // Calculate date ranges for sections
    const today = new Date().toISOString().split('T')[0];
    const future365Date = new Date();
    future365Date.setDate(future365Date.getDate() + 365);
    const futureEndDate = future365Date.toISOString().split('T')[0];

    const past365Date = new Date();
    past365Date.setDate(past365Date.getDate() - 365);
    const pastStartDate = past365Date.toISOString().split('T')[0];

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
      futureStats: {
        total_bookings: futureStats.totalBookings,
        total_revenue: futureStats.totalRevenue,
        available_days: futureStats.availableDays,
        booked_days: futureStats.bookedDays,
        blocked_days: futureStats.blockedDays,
        total_days: futureStats.availableDays + futureStats.bookedDays + futureStats.blockedDays,
        occupancy_rate: futureStats.occupancyRate,
        start_date: today,
        end_date: futureEndDate,
      },
      pastStats: {
        total_bookings: pastStats.totalBookings,
        total_revenue: pastStats.totalRevenue,
        available_days: pastStats.availableDays,
        booked_days: pastStats.bookedDays,
        blocked_days: pastStats.blockedDays,
        total_days: pastStats.availableDays + pastStats.bookedDays + pastStats.blockedDays,
        occupancy_rate: pastStats.occupancyRate,
        start_date: pastStartDate,
        end_date: today,
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
      pastBookings: pastBookings.map(r => ({
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
          pastBookings: pastBookings.length,
          futureRevenue: futureStats.totalRevenue,
          pastRevenue: pastStats.totalRevenue,
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
 */
export function shouldSendWeeklyEmail(): boolean {
  const now = new Date();
  const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const currentHour = now.getHours();

  return (
    currentDay === config.weeklyReportDay &&
    currentHour === config.weeklyReportHour
  );
}
