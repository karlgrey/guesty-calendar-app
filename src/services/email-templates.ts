/**
 * Email Templates
 *
 * HTML email templates for various notifications
 */

interface AllTimeStats {
  total_bookings: number;
  total_revenue: number;
  total_booked_days: number;
  start_date: string | null;
  end_date: string | null;
}

interface Booking {
  reservationId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestName: string;
  guestsCount: number;
  status: string;
  confirmationCode?: string;
  source: string;
  totalPrice: number;
  plannedArrival?: string;
  plannedDeparture?: string;
}

interface OccupancyRates {
  next4Weeks: number;
  last3Months: number;
}

interface ConversionRate {
  inquiries: number;
  confirmed: number;
  total: number;
  rate: number;
}

interface WebsiteAnalytics {
  enabled: boolean;
  uniqueVisitors: number;
  pageviews: number;
  sessions: number;
}

interface WeeklySummaryData {
  propertyTitle: string;
  currency: string;
  allTimeStats: AllTimeStats;
  occupancyRates: OccupancyRates;
  conversionRate: ConversionRate;
  websiteAnalytics?: WebsiteAnalytics;
  upcomingBookings: Booking[];
}

/**
 * Format currency value
 */
function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}

/**
 * Format date
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * Generate weekly summary email HTML
 */
export function generateWeeklySummaryEmail(data: WeeklySummaryData): { html: string; text: string } {
  const { propertyTitle, currency, allTimeStats, occupancyRates, conversionRate, websiteAnalytics, upcomingBookings } = data;

  const html = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Property Summary</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2c3e50;
      border-bottom: 3px solid #3498db;
      padding-bottom: 10px;
      margin-top: 0;
    }
    h2 {
      color: #34495e;
      margin-top: 30px;
      margin-bottom: 15px;
      font-size: 1.3em;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .stat-card {
      background-color: #f8f9fa;
      border-left: 4px solid #3498db;
      padding: 15px;
      border-radius: 4px;
    }
    .stat-label {
      font-size: 0.85em;
      color: #7f8c8d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .stat-value {
      font-size: 1.8em;
      font-weight: bold;
      color: #2c3e50;
    }
    .stat-value.revenue {
      color: #27ae60;
    }
    .stat-value.occupancy {
      color: #e67e22;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
    }
    th {
      background-color: #34495e;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: 600;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #ecf0f1;
    }
    tr:hover {
      background-color: #f8f9fa;
    }
    .status-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .status-confirmed {
      background-color: #d4edda;
      color: #155724;
    }
    .status-pending {
      background-color: #fff3cd;
      color: #856404;
    }
    .no-data {
      text-align: center;
      padding: 30px;
      color: #95a5a6;
      font-style: italic;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ecf0f1;
      font-size: 0.9em;
      color: #7f8c8d;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Weekly Property Summary</h1>
    <p><strong>${propertyTitle}</strong></p>

    <!-- ALL TIME SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #9b59b6; padding-bottom: 8px;">🌟 All Time Summary</h2>
    ${allTimeStats.start_date && allTimeStats.end_date ? `
    <p style="color: #7f8c8d; margin-top: 10px; margin-bottom: 20px;">
      <em>${formatDate(allTimeStats.start_date)} - ${formatDate(allTimeStats.end_date)}</em>
    </p>
    ` : ''}

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Bookings</div>
        <div class="stat-value">${allTimeStats.total_bookings}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value revenue">${formatCurrency(allTimeStats.total_revenue, currency)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Booked Days</div>
        <div class="stat-value">${allTimeStats.total_booked_days}</div>
      </div>
    </div>

    <!-- OCCUPANCY RATES SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #e67e22; padding-bottom: 8px;">📈 Occupancy Rate</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Next 4 Weeks</div>
        <div class="stat-value occupancy">${occupancyRates.next4Weeks}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last 3 Months</div>
        <div class="stat-value occupancy">${occupancyRates.last3Months}%</div>
      </div>
    </div>

    <!-- CONVERSION RATE SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #9b59b6; padding-bottom: 8px;">🎯 Reservation → Confirmed Conversion (All-Time)</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Reservations</div>
        <div class="stat-value">${conversionRate.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Confirmed Bookings</div>
        <div class="stat-value">${conversionRate.confirmed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Conversion Rate</div>
        <div class="stat-value" style="color: #9b59b6;">${conversionRate.rate}%</div>
        <div class="subvalue" style="color: #7f8c8d; margin-top: 5px;">${conversionRate.confirmed} of ${conversionRate.total} reservations</div>
      </div>
    </div>

    ${websiteAnalytics?.enabled ? `
    <!-- WEBSITE ANALYTICS SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #4285f4; padding-bottom: 8px;">📈 Website Analytics (Last 30 Days)</h2>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: #4285f4;">
        <div class="stat-label">Unique Visitors</div>
        <div class="stat-value" style="color: #4285f4;">${websiteAnalytics.uniqueVisitors.toLocaleString()}</div>
      </div>
      <div class="stat-card" style="border-left-color: #34a853;">
        <div class="stat-label">Page Views</div>
        <div class="stat-value">${websiteAnalytics.pageviews.toLocaleString()}</div>
      </div>
      <div class="stat-card" style="border-left-color: #fbbc05;">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${websiteAnalytics.sessions.toLocaleString()}</div>
      </div>
    </div>
    ` : ''}

    <!-- UPCOMING BOOKINGS SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #3498db; padding-bottom: 8px;">📅 Next 5 Upcoming Bookings</h2>
    ${upcomingBookings.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Guest</th>
          <th>Check-in</th>
          <th>Check-out</th>
          <th>Nights</th>
          <th>Guests</th>
          <th>Price</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${upcomingBookings.map(booking => `
        <tr>
          <td><strong>${booking.guestName}</strong><br/><small style="color: #7f8c8d;">${booking.source}</small></td>
          <td>${formatDate(booking.checkIn)}</td>
          <td>${formatDate(booking.checkOut)}</td>
          <td>${booking.nights}</td>
          <td>${booking.guestsCount}</td>
          <td><strong>${formatCurrency(booking.totalPrice, currency)}</strong></td>
          <td><span class="status-badge status-${booking.status}">${booking.status}</span></td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ` : `
    <div class="no-data">No upcoming bookings</div>
    `}

    <div class="footer">
      <p>This is an automated weekly summary generated by Guesty Calendar App</p>
    </div>
  </div>
</body>
</html>
  `;

  // Plain text version
  const text = `
Weekly Property Summary - ${propertyTitle}
${'='.repeat(60)}

ALL TIME SUMMARY
${'='.repeat(60)}
${allTimeStats.start_date && allTimeStats.end_date ? `${formatDate(allTimeStats.start_date)} - ${formatDate(allTimeStats.end_date)}` : ''}

Statistics:
- Total Bookings: ${allTimeStats.total_bookings}
- Total Revenue: ${formatCurrency(allTimeStats.total_revenue, currency)}
- Total Booked Days: ${allTimeStats.total_booked_days}

OCCUPANCY RATE
${'='.repeat(60)}

- Next 4 Weeks: ${occupancyRates.next4Weeks}%
- Last 3 Months: ${occupancyRates.last3Months}%

RESERVATION → CONFIRMED CONVERSION (All-Time)
${'='.repeat(60)}

- Total Reservations: ${conversionRate.total}
- Confirmed Bookings: ${conversionRate.confirmed}
- Pending/Other: ${conversionRate.total - conversionRate.confirmed}
- Conversion Rate: ${conversionRate.rate}% (${conversionRate.confirmed} of ${conversionRate.total})

${websiteAnalytics?.enabled ? `WEBSITE ANALYTICS (Last 30 Days)
${'='.repeat(60)}

- Unique Visitors: ${websiteAnalytics.uniqueVisitors.toLocaleString()}
- Page Views: ${websiteAnalytics.pageviews.toLocaleString()}
- Sessions: ${websiteAnalytics.sessions.toLocaleString()}

` : ''}NEXT 5 UPCOMING BOOKINGS
${'='.repeat(60)}

${upcomingBookings.length > 0
  ? upcomingBookings.map(b =>
    `- ${b.guestName} | ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} | ${b.nights} nights | ${formatCurrency(b.totalPrice, currency)} | ${b.status}`
  ).join('\n')
  : 'No upcoming bookings'}

---
This is an automated weekly summary.
  `.trim();

  return { html, text };
}
