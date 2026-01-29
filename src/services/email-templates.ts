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

interface MonthlyTrafficComparison {
  currentMonth: {
    pageviews: number;
    users: number;
    sessions: number;
    label: string;
  };
  previousMonth: {
    pageviews: number;
    users: number;
    sessions: number;
    label: string;
  };
  change: {
    pageviews: number;
    users: number;
    sessions: number;
  };
}

interface RegionData {
  region: string;
  users: number;
  sessions: number;
}

interface DailyData {
  date: string;
  users: number;
  pageviews: number;
}

interface TrendData {
  currentMonth: DailyData[];
  previousMonth: DailyData[];
  currentMonthLabel: string;
  previousMonthLabel: string;
}

interface WebsiteAnalytics {
  enabled: boolean;
  uniqueVisitors: number;
  pageviews: number;
  sessions: number;
  monthlyComparison?: MonthlyTrafficComparison;
  topRegions?: RegionData[];
  trendData?: TrendData;
}

interface CurrentYearStats {
  year: number;
  total_bookings: number;
  total_revenue: number;
  total_booked_days: number;
}

interface MonthlyBookingComparison {
  currentMonth: {
    bookings: number;
    revenue: number;
    nights: number;
    label: string;
  };
  previousMonth: {
    bookings: number;
    revenue: number;
    nights: number;
    label: string;
  };
  change: {
    bookings: number;
    revenue: number;
    nights: number;
  };
}

interface WeeklySummaryData {
  propertyTitle: string;
  currency: string;
  allTimeStats: AllTimeStats;
  currentYearStats?: CurrentYearStats;
  bookingComparison?: MonthlyBookingComparison;
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
 * Format change percentage with color and arrow
 */
function formatChange(change: number): string {
  const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
  const color = change > 0 ? '#27ae60' : change < 0 ? '#e74c3c' : '#7f8c8d';
  const sign = change > 0 ? '+' : '';
  return `<span style="color: ${color}; font-weight: bold;">${arrow} ${sign}${change}%</span>`;
}

/**
 * Generate QuickChart URL for 30-day traffic trend line chart
 */
function generateTrendChartUrl(trendData: TrendData): string {
  // Sort data by date
  const prevSorted = [...trendData.previousMonth].sort((a, b) => a.date.localeCompare(b.date));
  const currSorted = [...trendData.currentMonth].sort((a, b) => a.date.localeCompare(b.date));

  // Extract users in order (already sorted by date)
  const prevUsers = prevSorted.map(d => d.users);
  const currUsers = currSorted.map(d => d.users);

  // Use dates from current period as labels (DD.MM format)
  const labels = currSorted.map(d => {
    const date = new Date(d.date);
    return `${date.getDate()}.${date.getMonth() + 1}`;
  });

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Visitors ${trendData.previousMonthLabel}`,
          data: prevUsers,
          borderColor: '#95a5a6',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          borderDash: [5, 5],
        },
        {
          label: `Visitors ${trendData.currentMonthLabel}`,
          data: currUsers,
          borderColor: '#4285f4',
          backgroundColor: 'rgba(66, 133, 244, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        legend: {
          position: 'top',
        },
      },
      scales: {
        x: {
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
        },
      },
    },
  };

  const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encodedConfig}&w=700&h=300&bkg=white`;
}

/**
 * Generate weekly summary email HTML
 */
export function generateWeeklySummaryEmail(data: WeeklySummaryData): { html: string; text: string } {
  const { propertyTitle, currency, allTimeStats, currentYearStats, bookingComparison, occupancyRates, conversionRate, websiteAnalytics, upcomingBookings } = data;

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

    ${currentYearStats ? `
    <!-- CURRENT YEAR SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #27ae60; padding-bottom: 8px;">📅 ${currentYearStats.year} Expected Revenue</h2>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: #27ae60;">
        <div class="stat-label">Bookings ${currentYearStats.year}</div>
        <div class="stat-value">${currentYearStats.total_bookings}</div>
      </div>
      <div class="stat-card" style="border-left-color: #27ae60;">
        <div class="stat-label">Expected Revenue ${currentYearStats.year}</div>
        <div class="stat-value revenue">${formatCurrency(currentYearStats.total_revenue, currency)}</div>
      </div>
      <div class="stat-card" style="border-left-color: #27ae60;">
        <div class="stat-label">Booked Days ${currentYearStats.year}</div>
        <div class="stat-value">${currentYearStats.total_booked_days}</div>
      </div>
    </div>
    ` : ''}

    ${bookingComparison ? `
    <!-- MONTHLY BOOKING COMPARISON -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #3498db; padding-bottom: 8px;">📊 Bookings: ${bookingComparison.currentMonth.label} vs ${bookingComparison.previousMonth.label}</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Bookings</div>
        <div class="stat-value">${bookingComparison.currentMonth.bookings}</div>
        <div style="margin-top: 5px;">${formatChange(bookingComparison.change.bookings)} vs. ${bookingComparison.previousMonth.bookings}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Revenue</div>
        <div class="stat-value revenue">${formatCurrency(bookingComparison.currentMonth.revenue, currency)}</div>
        <div style="margin-top: 5px;">${formatChange(bookingComparison.change.revenue)} vs. ${formatCurrency(bookingComparison.previousMonth.revenue, currency)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Nights</div>
        <div class="stat-value">${bookingComparison.currentMonth.nights}</div>
        <div style="margin-top: 5px;">${formatChange(bookingComparison.change.nights)} vs. ${bookingComparison.previousMonth.nights}</div>
      </div>
    </div>
    ` : ''}

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

    ${websiteAnalytics?.enabled && websiteAnalytics.monthlyComparison ? `
    <!-- WEBSITE ANALYTICS SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #4285f4; padding-bottom: 8px;">📈 Website Traffic: ${websiteAnalytics.monthlyComparison.currentMonth.label} vs ${websiteAnalytics.monthlyComparison.previousMonth.label}</h2>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: #4285f4;">
        <div class="stat-label">Visitors</div>
        <div class="stat-value" style="font-size: 1.4em;">${websiteAnalytics.monthlyComparison.currentMonth.users.toLocaleString()}</div>
        <div style="margin-top: 5px;">${formatChange(websiteAnalytics.monthlyComparison.change.users)} vs. ${websiteAnalytics.monthlyComparison.previousMonth.users.toLocaleString()}</div>
      </div>
      <div class="stat-card" style="border-left-color: #34a853;">
        <div class="stat-label">Pageviews</div>
        <div class="stat-value" style="font-size: 1.4em;">${websiteAnalytics.monthlyComparison.currentMonth.pageviews.toLocaleString()}</div>
        <div style="margin-top: 5px;">${formatChange(websiteAnalytics.monthlyComparison.change.pageviews)} vs. ${websiteAnalytics.monthlyComparison.previousMonth.pageviews.toLocaleString()}</div>
      </div>
      <div class="stat-card" style="border-left-color: #fbbc05;">
        <div class="stat-label">Sessions</div>
        <div class="stat-value" style="font-size: 1.4em;">${websiteAnalytics.monthlyComparison.currentMonth.sessions.toLocaleString()}</div>
        <div style="margin-top: 5px;">${formatChange(websiteAnalytics.monthlyComparison.change.sessions)} vs. ${websiteAnalytics.monthlyComparison.previousMonth.sessions.toLocaleString()}</div>
      </div>
    </div>

    ${websiteAnalytics.trendData && websiteAnalytics.trendData.currentMonth.length > 0 ? `
    <div style="margin-top: 20px; text-align: center;">
      <img src="${generateTrendChartUrl(websiteAnalytics.trendData)}" alt="Traffic Trend" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" />
    </div>
    ` : ''}

    ${websiteAnalytics.topRegions && websiteAnalytics.topRegions.length > 0 ? `
    <!-- TOP REGIONS -->
    <h3 style="margin-top: 25px; color: #34495e; font-size: 1.1em;">🗺️ Top Regions</h3>
    <table style="width: 100%; margin-top: 10px;">
      <thead>
        <tr>
          <th style="background-color: #4285f4; color: white; padding: 8px; text-align: left;">Region</th>
          <th style="background-color: #4285f4; color: white; padding: 8px; text-align: right;">Visitors</th>
          <th style="background-color: #4285f4; color: white; padding: 8px; text-align: right;">Sessions</th>
        </tr>
      </thead>
      <tbody>
        ${websiteAnalytics.topRegions.slice(0, 5).map(region => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ecf0f1;">${region.region}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ecf0f1; text-align: right;">${region.users.toLocaleString()}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ecf0f1; text-align: right;">${region.sessions.toLocaleString()}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}
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

${currentYearStats ? `${currentYearStats.year} EXPECTED REVENUE
${'='.repeat(60)}

- Bookings: ${currentYearStats.total_bookings}
- Expected Revenue: ${formatCurrency(currentYearStats.total_revenue, currency)}
- Booked Days: ${currentYearStats.total_booked_days}

` : ''}${bookingComparison ? `BOOKINGS: ${bookingComparison.currentMonth.label} vs ${bookingComparison.previousMonth.label}
${'='.repeat(60)}

- Bookings: ${bookingComparison.currentMonth.bookings} (${bookingComparison.change.bookings > 0 ? '+' : ''}${bookingComparison.change.bookings}% vs. ${bookingComparison.previousMonth.bookings})
- Revenue: ${formatCurrency(bookingComparison.currentMonth.revenue, currency)} (${bookingComparison.change.revenue > 0 ? '+' : ''}${bookingComparison.change.revenue}%)
- Nights: ${bookingComparison.currentMonth.nights} (${bookingComparison.change.nights > 0 ? '+' : ''}${bookingComparison.change.nights}%)

` : ''}ALL TIME SUMMARY
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

${websiteAnalytics?.enabled && websiteAnalytics.monthlyComparison ? `WEBSITE TRAFFIC: ${websiteAnalytics.monthlyComparison.currentMonth.label} vs ${websiteAnalytics.monthlyComparison.previousMonth.label}
${'='.repeat(60)}

- Visitors: ${websiteAnalytics.monthlyComparison.currentMonth.users} (${websiteAnalytics.monthlyComparison.change.users > 0 ? '+' : ''}${websiteAnalytics.monthlyComparison.change.users}%)
- Pageviews: ${websiteAnalytics.monthlyComparison.currentMonth.pageviews} (${websiteAnalytics.monthlyComparison.change.pageviews > 0 ? '+' : ''}${websiteAnalytics.monthlyComparison.change.pageviews}%)
- Sessions: ${websiteAnalytics.monthlyComparison.currentMonth.sessions} (${websiteAnalytics.monthlyComparison.change.sessions > 0 ? '+' : ''}${websiteAnalytics.monthlyComparison.change.sessions}%)
${websiteAnalytics.topRegions && websiteAnalytics.topRegions.length > 0 ? `
Top Regions:
${websiteAnalytics.topRegions.slice(0, 5).map(r => `- ${r.region}: ${r.users} visitors`).join('\n')}
` : ''}
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
