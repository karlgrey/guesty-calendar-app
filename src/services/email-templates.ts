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

interface DashboardStats {
  total_bookings: number;
  total_revenue: number;
  available_days: number;
  booked_days: number;
  blocked_days: number;
  total_days: number;
  occupancy_rate: number;
  start_date: string;
  end_date: string;
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

interface WeeklySummaryData {
  propertyTitle: string;
  currency: string;
  allTimeStats: AllTimeStats;
  futureStats: DashboardStats;
  pastStats: DashboardStats;
  upcomingBookings: Booking[];
  pastBookings: Booking[];
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
 * Format percentage
 */
function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Generate weekly summary email HTML
 */
export function generateWeeklySummaryEmail(data: WeeklySummaryData): { html: string; text: string } {
  const { propertyTitle, currency, allTimeStats, futureStats, pastStats, upcomingBookings, pastBookings } = data;

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

    <!-- FUTURE 365 DAYS SECTION -->
    <h2 style="margin-top: 40px; border-bottom: 2px solid #3498db; padding-bottom: 8px;">📈 Next 365 Days</h2>
    <p style="color: #7f8c8d; margin-top: 10px; margin-bottom: 20px;">
      <em>${formatDate(futureStats.start_date)} - ${formatDate(futureStats.end_date)}</em>
    </p>

    <h3 style="font-size: 1.1em; color: #34495e; margin-top: 20px;">Statistics</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Bookings</div>
        <div class="stat-value">${futureStats.total_bookings}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value revenue">${formatCurrency(futureStats.total_revenue, currency)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Occupancy Rate</div>
        <div class="stat-value occupancy">${formatPercent(futureStats.occupancy_rate)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Available Days</div>
        <div class="stat-value">${futureStats.available_days}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Booked Days</div>
        <div class="stat-value">${futureStats.booked_days}</div>
      </div>
    </div>

    <h3 style="font-size: 1.1em; color: #34495e; margin-top: 25px;">Upcoming Bookings</h3>
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

    <!-- PAST 365 DAYS SECTION -->
    <h2 style="margin-top: 50px; border-bottom: 2px solid #27ae60; padding-bottom: 8px;">📊 Past 365 Days</h2>
    <p style="color: #7f8c8d; margin-top: 10px; margin-bottom: 20px;">
      <em>${formatDate(pastStats.start_date)} - ${formatDate(pastStats.end_date)}</em>
    </p>

    <h3 style="font-size: 1.1em; color: #34495e; margin-top: 20px;">Statistics</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Bookings</div>
        <div class="stat-value">${pastStats.total_bookings}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value revenue">${formatCurrency(pastStats.total_revenue, currency)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Occupancy Rate</div>
        <div class="stat-value occupancy">${formatPercent(pastStats.occupancy_rate)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Available Days</div>
        <div class="stat-value">${pastStats.available_days}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Booked Days</div>
        <div class="stat-value">${pastStats.booked_days}</div>
      </div>
    </div>

    <h3 style="font-size: 1.1em; color: #34495e; margin-top: 25px;">All Bookings</h3>
    ${pastBookings.length > 0 ? `
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
        ${pastBookings.map(booking => `
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
    <div class="no-data">No past bookings</div>
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

NEXT 365 DAYS
${'='.repeat(60)}
${formatDate(futureStats.start_date)} - ${formatDate(futureStats.end_date)}

Statistics:
- Total Bookings: ${futureStats.total_bookings}
- Total Revenue: ${formatCurrency(futureStats.total_revenue, currency)}
- Occupancy Rate: ${formatPercent(futureStats.occupancy_rate)}
- Available Days: ${futureStats.available_days}
- Booked Days: ${futureStats.booked_days}

Upcoming Bookings:
${upcomingBookings.length > 0
  ? upcomingBookings.map(b =>
    `- ${b.guestName} | ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} | ${b.nights} nights | ${formatCurrency(b.totalPrice, currency)} | ${b.status}`
  ).join('\n')
  : 'No upcoming bookings'}

PAST 365 DAYS
${'='.repeat(60)}
${formatDate(pastStats.start_date)} - ${formatDate(pastStats.end_date)}

Statistics:
- Total Bookings: ${pastStats.total_bookings}
- Total Revenue: ${formatCurrency(pastStats.total_revenue, currency)}
- Occupancy Rate: ${formatPercent(pastStats.occupancy_rate)}
- Available Days: ${pastStats.available_days}
- Booked Days: ${pastStats.booked_days}

All Past Bookings:
${pastBookings.length > 0
  ? pastBookings.map(b =>
    `- ${b.guestName} | ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)} | ${b.nights} nights | ${formatCurrency(b.totalPrice, currency)} | ${b.status}`
  ).join('\n')
  : 'No past bookings'}

---
This is an automated weekly summary.
  `.trim();

  return { html, text };
}
