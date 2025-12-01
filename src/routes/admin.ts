/**
 * Admin Routes
 *
 * Backend admin interface for database viewing, manual sync triggers, and health monitoring.
 */

import express from 'express';
import { getDatabase } from '../db/index.js';
import { syncConfiguredListing } from '../jobs/sync-listing.js';
import { syncConfiguredAvailability } from '../jobs/sync-availability.js';
import { runETLJob } from '../jobs/etl-job.js';
import { getSchedulerStatus } from '../jobs/scheduler.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { getDashboardStats, getAllTimeConversionRate } from '../repositories/availability-repository.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import { getAnalyticsSummary, getLatestTopPages, getLastSyncTime, hasAnalyticsData } from '../repositories/analytics-repository.js';
import { syncAnalytics } from '../jobs/sync-analytics.js';
import { ga4Client } from '../services/ga4-client.js';
import { createOrGetDocument, refreshDocument } from '../services/document-service.js';
import { getDocumentsByReservation, listDocuments } from '../repositories/document-repository.js';

const router = express.Router();

/**
 * GET /admin
 * Admin dashboard HTML
 */
router.get('/', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guesty Calendar Admin</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    h1 {
      color: #333;
      margin-bottom: 30px;
      font-size: 32px;
    }

    h2 {
      color: #555;
      margin: 30px 0 15px;
      font-size: 24px;
      border-bottom: 2px solid #007bff;
      padding-bottom: 10px;
    }

    .section {
      background: white;
      padding: 25px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #007bff;
    }

    .card h3 {
      font-size: 14px;
      color: #666;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .card .value {
      font-size: 28px;
      font-weight: bold;
      color: #333;
    }

    .card .subvalue {
      font-size: 14px;
      color: #888;
      margin-top: 5px;
    }

    button {
      background: #007bff;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 15px;
      font-weight: 500;
      transition: background 0.2s;
      margin-right: 10px;
      margin-bottom: 10px;
    }

    button:hover {
      background: #0056b3;
    }

    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    button.success {
      background: #28a745;
    }

    button.success:hover {
      background: #218838;
    }

    button.danger {
      background: #dc3545;
    }

    button.danger:hover {
      background: #c82333;
    }

    .status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
    }

    .status.running {
      background: #d4edda;
      color: #155724;
    }

    .status.stopped {
      background: #f8d7da;
      color: #721c24;
    }

    /* Document buttons */
    .doc-btn {
      padding: 4px 8px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 4px;
      transition: background 0.2s, opacity 0.2s;
    }

    .doc-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .quote-btn {
      background: #17a2b8;
      color: white;
    }

    .quote-btn:hover:not(:disabled) {
      background: #138496;
    }

    .invoice-btn {
      background: #28a745;
      color: white;
    }

    .invoice-btn:hover:not(:disabled) {
      background: #218838;
    }

    .refresh-btn {
      background: #6c757d;
      color: white;
      font-size: 10px;
      padding: 4px 6px;
    }

    .refresh-btn:hover:not(:disabled) {
      background: #5a6268;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }

    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }

    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #555;
    }

    tr:hover {
      background: #f8f9fa;
    }

    pre {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
    }

    .message {
      padding: 12px 16px;
      border-radius: 6px;
      margin: 15px 0;
      display: none;
    }

    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }

    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }

    .message.show {
      display: block;
    }

    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #f3f3f3;
      border-top: 2px solid #007bff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-left: 8px;
      vertical-align: middle;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .actions {
      margin-top: 20px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
    }

    button.secondary {
      background: #6c757d;
    }

    button.secondary:hover {
      background: #5a6268;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛠️ Guesty Calendar Admin</h1>
      <a href="/auth/logout"><button class="secondary">Logout</button></a>
    </div>

    <div id="message" class="message"></div>

    <!-- Dashboard Stats -->
    <div class="section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h2 style="margin: 0;">📊 Dashboard Overview</h2>
        <div style="display: flex; gap: 10px;">
          <button id="btnFuture" class="success" onclick="switchPeriod('future')">Next 12 Months</button>
          <button id="btnPast" onclick="switchPeriod('past')">Last 12 Months</button>
        </div>
      </div>
      <div class="grid" id="statsGrid">
        <div class="card">
          <h3>Loading...</h3>
          <div class="value">...</div>
        </div>
      </div>
    </div>

    <!-- Conversion Rate Stats -->
    <div class="section">
      <h2>🎯 Reservation → Confirmed Conversion (All-Time)</h2>
      <div class="grid" id="conversionGrid">
        <div class="card">
          <h3>Loading...</h3>
          <div class="value">...</div>
        </div>
      </div>
    </div>

    <!-- Website Analytics (GA4) -->
    <div class="section" id="analyticsSection" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h2 style="margin: 0;">📈 Website Analytics (Last 30 Days)</h2>
        <button onclick="syncAnalytics()" id="syncAnalyticsBtn">🔄 Sync Now</button>
      </div>
      <div class="grid" id="analyticsGrid">
        <div class="card">
          <h3>Loading...</h3>
          <div class="value">...</div>
        </div>
      </div>
      <div id="topPagesSection" style="margin-top: 20px;">
        <h3 style="margin-bottom: 15px; color: #555;">Top 10 Pages</h3>
        <div id="topPagesTable">Loading...</div>
      </div>
    </div>

    <!-- Bookings -->
    <div class="section">
      <h2 id="bookingsTitle">📅 Upcoming Bookings</h2>
      <div id="bookingsTable">Loading bookings...</div>
    </div>

    <!-- Health Status -->
    <div class="section">
      <h2>System Health</h2>
      <div class="grid" id="healthGrid">
        <div class="card">
          <h3>Status</h3>
          <div class="value">Loading...</div>
        </div>
      </div>
    </div>

    <!-- User Management -->
    <div class="section">
      <h2>User Management</h2>
      <p style="color: #666; margin-bottom: 20px;">Manage admin users who can access this panel</p>
      <div class="actions">
        <button onclick="window.location.href='/admin/users'">👥 Manage Users</button>
      </div>
    </div>

    <!-- Manual Sync -->
    <div class="section">
      <h2>Manual Data Sync</h2>
      <p style="color: #666; margin-bottom: 20px;">Trigger immediate data refresh from Guesty API</p>
      <div class="actions">
        <button onclick="syncAll()">🔄 Sync All (Listing + Availability)</button>
        <button onclick="syncListing()">📄 Sync Listing Only</button>
        <button onclick="syncAvailability()">📅 Sync Availability Only</button>
      </div>
    </div>

    <!-- Database Viewer -->
    <div class="section">
      <h2>Database</h2>
      <div class="actions">
        <button onclick="viewTable('listings')">View Listings</button>
        <button onclick="viewTable('availability')">View Availability</button>
        <button onclick="viewTable('cached_quotes')">View Cached Quotes</button>
      </div>
      <div id="tableView"></div>
    </div>

    <!-- Scheduler Status -->
    <div class="section">
      <h2>ETL Scheduler</h2>
      <div id="schedulerStatus">Loading...</div>
    </div>
  </div>

  <script>
    let currentPeriod = 'future'; // Track current period

    function showMessage(text, type = 'success') {
      const msg = document.getElementById('message');
      msg.textContent = text;
      msg.className = 'message show ' + type;
      setTimeout(() => {
        msg.className = 'message';
      }, 5000);
    }

    function switchPeriod(period) {
      currentPeriod = period;

      // Update button styles
      const btnFuture = document.getElementById('btnFuture');
      const btnPast = document.getElementById('btnPast');

      if (period === 'future') {
        btnFuture.classList.add('success');
        btnPast.classList.remove('success');
      } else {
        btnPast.classList.add('success');
        btnFuture.classList.remove('success');
      }

      // Update bookings title
      const bookingsTitle = document.getElementById('bookingsTitle');
      bookingsTitle.textContent = period === 'future' ? '📅 Upcoming Bookings' : '📅 Past Bookings';

      // Reload dashboard data
      loadDashboard();
    }

    async function loadHealth() {
      try {
        const res = await fetch('/admin/health');
        const data = await res.json();

        const grid = document.getElementById('healthGrid');

        // Determine last sync status
        let lastSyncHtml = '';
        if (data.scheduler.lastSuccessfulRun) {
          const successDate = new Date(data.scheduler.lastSuccessfulRun);
          lastSyncHtml = \`
            <div class="value" style="color: #28a745;">\${successDate.toLocaleTimeString()}</div>
            <div class="subvalue" style="color: #28a745;">✓ Success · \${successDate.toLocaleDateString()}</div>
          \`;
        } else if (data.scheduler.lastFailedRun) {
          const failDate = new Date(data.scheduler.lastFailedRun);
          lastSyncHtml = \`
            <div class="value" style="color: #dc3545;">\${failDate.toLocaleTimeString()}</div>
            <div class="subvalue" style="color: #dc3545;">✗ Failed · \${failDate.toLocaleDateString()}</div>
          \`;
        } else {
          lastSyncHtml = \`
            <div class="value">Never</div>
            <div class="subvalue">No syncs yet</div>
          \`;
        }

        grid.innerHTML = \`
          <div class="card">
            <h3>Database</h3>
            <div class="value">\${data.database}</div>
            <div class="subvalue">Initialized: \${data.databaseInitialized ? 'Yes' : 'No'}</div>
          </div>
          <div class="card">
            <h3>Scheduler</h3>
            <div class="value">\${data.scheduler.running ? 'Running' : 'Stopped'}</div>
            <div class="subvalue">Success: \${data.scheduler.successCount || 0} · Failed: \${data.scheduler.failureCount || 0}</div>
          </div>
          <div class="card">
            <h3>Last Successful Sync</h3>
            \${lastSyncHtml}
          </div>
          <div class="card">
            <h3>Next Sync</h3>
            <div class="value">\${data.scheduler.nextRun ? new Date(data.scheduler.nextRun).toLocaleTimeString() : 'N/A'}</div>
            <div class="subvalue">Interval: \${data.scheduler.intervalMinutes} min</div>
          </div>
        \`;

        // Scheduler status
        const schedulerDiv = document.getElementById('schedulerStatus');
        schedulerDiv.innerHTML = \`
          <div class="grid">
            <div class="card">
              <h3>Status</h3>
              <div class="value"><span class="status \${data.scheduler.running ? 'running' : 'stopped'}">\${data.scheduler.running ? 'Running' : 'Stopped'}</span></div>
            </div>
            <div class="card">
              <h3>Total Jobs</h3>
              <div class="value">\${data.scheduler.jobCount || 0}</div>
              <div class="subvalue" style="color: #28a745;">✓ \${data.scheduler.successCount || 0} success</div>
              <div class="subvalue" style="color: #dc3545;">✗ \${data.scheduler.failureCount || 0} failed</div>
            </div>
            <div class="card">
              <h3>Refresh Interval</h3>
              <div class="value">\${data.scheduler.intervalMinutes}</div>
              <div class="subvalue">minutes</div>
            </div>
          </div>
        \`;
      } catch (error) {
        showMessage('Failed to load health status: ' + error.message, 'error');
      }
    }

    async function syncAll() {
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '🔄 Syncing... <span class="loading"></span>';

      try {
        const res = await fetch('/admin/sync/all', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          showMessage(\`✅ Sync completed in \${data.duration}ms\`, 'success');
          loadHealth();
        } else {
          showMessage('❌ Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('❌ Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Sync All (Listing + Availability)';
      }
    }

    async function syncListing() {
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '📄 Syncing... <span class="loading"></span>';

      try {
        const res = await fetch('/admin/sync/listing', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          showMessage(\`✅ Listing synced\`, 'success');
          loadHealth();
        } else {
          showMessage('❌ Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('❌ Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '📄 Sync Listing Only';
      }
    }

    async function syncAvailability() {
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '📅 Syncing... <span class="loading"></span>';

      try {
        const res = await fetch('/admin/sync/availability', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          showMessage(\`✅ Availability synced (\${data.daysCount || 0} days)\`, 'success');
          loadHealth();
        } else {
          showMessage('❌ Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('❌ Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '📅 Sync Availability Only';
      }
    }

    async function viewTable(tableName) {
      const tableView = document.getElementById('tableView');
      tableView.innerHTML = '<p style="margin-top: 15px;">Loading...</p>';

      try {
        const res = await fetch(\`/admin/db/\${tableName}\`);
        const data = await res.json();

        if (data.rows.length === 0) {
          tableView.innerHTML = '<p style="margin-top: 15px; color: #888;">No data found in this table.</p>';
          return;
        }

        const columns = Object.keys(data.rows[0]);

        let html = \`
          <h3 style="margin-top: 20px; color: #555;">\${tableName} (\${data.count} rows)</h3>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>\${columns.map(col => \`<th>\${col}</th>\`).join('')}</tr>
              </thead>
              <tbody>
                \${data.rows.slice(0, 50).map(row => \`
                  <tr>\${columns.map(col => {
                    let value = row[col];
                    if (value === null) value = '<em>null</em>';
                    else if (typeof value === 'object') value = JSON.stringify(value);
                    else if (typeof value === 'string' && value.length > 100) value = value.substring(0, 100) + '...';
                    return \`<td>\${value}</td>\`;
                  }).join('')}</tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
          \${data.count > 50 ? \`<p style="margin-top: 10px; color: #888;"><em>Showing first 50 of \${data.count} rows</em></p>\` : ''}
        \`;

        tableView.innerHTML = html;
      } catch (error) {
        tableView.innerHTML = \`<p style="margin-top: 15px; color: #dc3545;">Failed to load table: \${error.message}</p>\`;
      }
    }

    // Generate document (quote or invoice) - uses cached data if exists
    async function generateDocument(reservationId, documentType) {
      await downloadDocument('/admin/documents/generate', reservationId, documentType);
    }

    // Refresh document with fresh data from Guesty
    async function refreshDocument(reservationId, documentType) {
      await downloadDocument('/admin/documents/refresh', reservationId, documentType, true);
    }

    // Common download function for documents
    async function downloadDocument(endpoint, reservationId, documentType, isRefresh = false) {
      const btn = event.target;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = isRefresh ? 'Aktualisiere...' : 'Wird erstellt...';

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reservationId, documentType }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to generate document');
        }

        // Get the PDF blob and download it
        const blob = await response.blob();
        const documentNumber = response.headers.get('X-Document-Number') || 'document';
        const filename = documentType === 'quote'
          ? \`Angebot_\${documentNumber}.pdf\`
          : \`Rechnung_\${documentNumber}.pdf\`;

        // Create download link
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        // Show success indicator briefly
        btn.textContent = isRefresh ? 'Aktualisiert!' : 'Fertig!';
        btn.style.background = '#28a745';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.disabled = false;
        }, 2000);
      } catch (error) {
        console.error('Failed to generate document:', error);
        alert('Fehler beim Erstellen des Dokuments: ' + error.message);
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }

    async function loadDashboard() {
      try {
        const res = await fetch(\`/admin/dashboard-data?period=\${currentPeriod}\`);
        const data = await res.json();

        // Update stats cards
        const statsGrid = document.getElementById('statsGrid');
        const periodLabel = currentPeriod === 'future' ? 'Next 12 months' : 'Last 12 months';
        const revenueLabel = currentPeriod === 'future' ? 'Expected revenue' : 'Total revenue';

        statsGrid.innerHTML = \`
          <div class="card" style="border-left-color: #28a745;">
            <h3>Total Bookings</h3>
            <div class="value">\${data.stats.totalBookings}</div>
            <div class="subvalue">\${periodLabel}</div>
          </div>
          <div class="card" style="border-left-color: #17a2b8;">
            <h3>\${currentPeriod === 'future' ? 'Expected' : 'Total'} Revenue</h3>
            <div class="value">\${data.listing.currency} \${data.stats.totalRevenue.toLocaleString()}</div>
            <div class="subvalue">\${revenueLabel}</div>
          </div>
          <div class="card" style="border-left-color: #ffc107;">
            <h3>Occupancy Rate</h3>
            <div class="value">\${data.stats.occupancyRate}%</div>
            <div class="subvalue">\${data.stats.bookedDays} of \${data.stats.bookedDays + data.stats.availableDays} days</div>
          </div>
          <div class="card" style="border-left-color: #6c757d;">
            <h3>\${currentPeriod === 'future' ? 'Availability' : 'Available Days'}</h3>
            <div class="value">\${data.stats.availableDays}</div>
            <div class="subvalue">Available days · \${data.stats.blockedDays} blocked</div>
          </div>
        \`;

        // Update conversion rate cards
        const conversionGrid = document.getElementById('conversionGrid');
        conversionGrid.innerHTML = \`
          <div class="card" style="border-left-color: #007bff;">
            <h3>Total Reservations</h3>
            <div class="value">\${data.conversion.totalCount}</div>
            <div class="subvalue">All-time reservations</div>
          </div>
          <div class="card" style="border-left-color: #28a745;">
            <h3>Confirmed Bookings</h3>
            <div class="value">\${data.conversion.confirmedCount}</div>
            <div class="subvalue">Successfully converted</div>
          </div>
          <div class="card" style="border-left-color: #6c757d;">
            <h3>Pending/Other</h3>
            <div class="value">\${data.conversion.totalCount - data.conversion.confirmedCount}</div>
            <div class="subvalue">Open, declined, canceled</div>
          </div>
          <div class="card" style="border-left-color: #9b59b6;">
            <h3>Conversion Rate</h3>
            <div class="value" style="color: #9b59b6;">\${data.conversion.conversionRate}%</div>
            <div class="subvalue">\${data.conversion.confirmedCount} of \${data.conversion.totalCount} reservations</div>
          </div>
        \`;

        // Update bookings table
        const bookingsTable = document.getElementById('bookingsTable');

        if (data.bookings.length === 0) {
          bookingsTable.innerHTML = '<p style="color: #888;">No upcoming bookings found.</p>';
          return;
        }

        bookingsTable.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Confirmation</th>
                <th>Guest Name</th>
                <th>Check-In</th>
                <th>Check-Out</th>
                <th>Nights</th>
                <th>Guests</th>
                <th>Status</th>
                <th>Source</th>
                <th>Total Price</th>
                <th>Documents</th>
              </tr>
            </thead>
            <tbody>
              \${data.bookings.map(booking => {
                const checkIn = new Date(booking.checkIn);
                const checkOut = new Date(booking.checkOut);

                const statusClass = booking.status === 'confirmed' ? 'running' : 'stopped';
                const statusText = booking.status || 'Unknown';

                return \`
                  <tr>
                    <td style="font-family: monospace; font-size: 12px;">\${booking.confirmationCode || booking.reservationId.substring(0, 8)}</td>
                    <td>\${booking.guestName}</td>
                    <td>\${checkIn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td>\${checkOut.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td>\${booking.nights}</td>
                    <td>\${booking.guestsCount}</td>
                    <td><span class="status \${statusClass}">\${statusText}</span></td>
                    <td>\${booking.source}</td>
                    <td style="font-weight: 600;">\${data.listing.currency} \${Math.round(booking.totalPrice).toLocaleString()}</td>
                    <td>
                      <button class="doc-btn quote-btn" onclick="generateDocument('\${booking.reservationId}', 'quote')" title="Angebot erstellen/laden">
                        Angebot
                      </button>
                      <button class="doc-btn invoice-btn" onclick="generateDocument('\${booking.reservationId}', 'invoice')" title="Rechnung erstellen/laden">
                        Rechnung
                      </button>
                      <button class="doc-btn refresh-btn" onclick="refreshDocument('\${booking.reservationId}', 'quote')" title="Angebot mit aktuellen Guesty-Daten neu generieren">
                        ↻ A
                      </button>
                      <button class="doc-btn refresh-btn" onclick="refreshDocument('\${booking.reservationId}', 'invoice')" title="Rechnung mit aktuellen Guesty-Daten neu generieren">
                        ↻ R
                      </button>
                    </td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
        document.getElementById('statsGrid').innerHTML = '<p style="color: #dc3545;">Failed to load stats</p>';
        document.getElementById('bookingsTable').innerHTML = '<p style="color: #dc3545;">Failed to load bookings</p>';
      }
    }

    // Load analytics data
    async function loadAnalytics() {
      try {
        const res = await fetch('/admin/analytics-data');
        const data = await res.json();

        // Show/hide analytics section based on whether GA4 is enabled
        const analyticsSection = document.getElementById('analyticsSection');
        if (!data.enabled) {
          analyticsSection.style.display = 'none';
          return;
        }

        analyticsSection.style.display = 'block';

        // Update analytics cards
        const analyticsGrid = document.getElementById('analyticsGrid');

        if (!data.hasData) {
          analyticsGrid.innerHTML = \`
            <div class="card" style="grid-column: 1 / -1;">
              <h3>No Analytics Data</h3>
              <div class="value" style="font-size: 16px;">Click "Sync Now" to fetch analytics from Google Analytics 4</div>
            </div>
          \`;
          document.getElementById('topPagesTable').innerHTML = '';
          return;
        }

        // Format duration as minutes:seconds
        const avgDuration = data.summary.avgSessionDuration;
        const minutes = Math.floor(avgDuration / 60);
        const seconds = Math.round(avgDuration % 60);
        const durationFormatted = \`\${minutes}m \${seconds}s\`;

        analyticsGrid.innerHTML = \`
          <div class="card" style="border-left-color: #4285f4;">
            <h3>Pageviews</h3>
            <div class="value">\${data.summary.totalPageviews.toLocaleString()}</div>
            <div class="subvalue">Last 30 days</div>
          </div>
          <div class="card" style="border-left-color: #34a853;">
            <h3>Users</h3>
            <div class="value">\${data.summary.totalUsers.toLocaleString()}</div>
            <div class="subvalue">Unique visitors</div>
          </div>
          <div class="card" style="border-left-color: #fbbc05;">
            <h3>Sessions</h3>
            <div class="value">\${data.summary.totalSessions.toLocaleString()}</div>
            <div class="subvalue">Total sessions</div>
          </div>
          <div class="card" style="border-left-color: #ea4335;">
            <h3>Avg. Session Duration</h3>
            <div class="value">\${durationFormatted}</div>
            <div class="subvalue">Per session</div>
          </div>
        \`;

        // Update top pages table
        const topPagesTable = document.getElementById('topPagesTable');

        if (data.topPages.length === 0) {
          topPagesTable.innerHTML = '<p style="color: #888;">No page data available</p>';
          return;
        }

        topPagesTable.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th style="width: 50px;">#</th>
                <th>Page Path</th>
                <th>Title</th>
                <th style="text-align: right;">Pageviews</th>
              </tr>
            </thead>
            <tbody>
              \${data.topPages.map((page, index) => \`
                <tr>
                  <td>\${index + 1}</td>
                  <td style="font-family: monospace; font-size: 13px;">\${page.page_path}</td>
                  <td>\${page.page_title || '-'}</td>
                  <td style="text-align: right; font-weight: 600;">\${page.pageviews.toLocaleString()}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
          \${data.lastSync ? \`<p style="margin-top: 10px; color: #888; font-size: 12px;">Last synced: \${new Date(data.lastSync).toLocaleString()}</p>\` : ''}
        \`;
      } catch (error) {
        console.error('Failed to load analytics:', error);
      }
    }

    // Sync analytics manually
    async function syncAnalytics() {
      const btn = document.getElementById('syncAnalyticsBtn');
      btn.disabled = true;
      btn.innerHTML = '🔄 Syncing... <span class="loading"></span>';

      try {
        const res = await fetch('/admin/sync/analytics', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          showMessage(\`✅ Analytics synced (\${data.recordsSynced} records)\`, 'success');
          loadAnalytics();
        } else {
          showMessage('❌ Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('❌ Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Sync Now';
      }
    }

    // Load initial data
    loadHealth();
    loadDashboard();
    loadAnalytics();
    setInterval(loadHealth, 10000); // Refresh every 10 seconds

    // Only auto-refresh dashboard for future data (not past)
    setInterval(() => {
      if (currentPeriod === 'future') {
        loadDashboard();
      }
    }, 30000); // Refresh dashboard every 30 seconds if showing future
  </script>
</body>
</html>
  `);
});

/**
 * GET /admin/health
 * System health status JSON
 */
router.get('/health', (_req, res) => {
  const db = getDatabase();
  const schedulerStatus = getSchedulerStatus();

  // Check if database is initialized
  let databaseInitialized = false;
  try {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings'").get();
    databaseInitialized = !!result;
  } catch (error) {
    logger.error({ error }, 'Failed to check database initialization');
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: databaseInitialized ? 'Connected' : 'Not initialized',
    databaseInitialized,
    scheduler: schedulerStatus,
    config: {
      propertyId: config.guestyPropertyId,
      cacheAvailabilityTtl: config.cacheAvailabilityTtl,
      cacheListingTtl: config.cacheListingTtl,
      cacheQuoteTtl: config.cacheQuoteTtl,
    },
  });
});

/**
 * POST /admin/sync/all
 * Trigger full ETL job (listing + availability)
 */
router.post('/sync/all', async (_req, res, next) => {
  try {
    logger.info('Manual full sync triggered via admin');
    const result = await runETLJob(true); // force=true

    res.json({
      success: result.success,
      listing: result.listing,
      availability: result.availability,
      duration: result.duration,
      timestamp: result.timestamp,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /admin/sync/listing
 * Trigger listing sync only
 */
router.post('/sync/listing', async (_req, res, next) => {
  try {
    logger.info('Manual listing sync triggered via admin');
    const result = await syncConfiguredListing(true); // force=true

    res.json({
      success: result.success,
      listingId: result.listingId,
      title: result.title,
      skipped: result.skipped,
      error: result.error,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /admin/sync/availability
 * Trigger availability sync only
 */
router.post('/sync/availability', async (_req, res, next) => {
  try {
    logger.info('Manual availability sync triggered via admin');
    const result = await syncConfiguredAvailability(true); // force=true

    res.json({
      success: result.success,
      listingId: result.listingId,
      daysCount: result.daysCount,
      skipped: result.skipped,
      error: result.error,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/db/:table
 * View database table contents
 */
router.get('/db/:table', (req, res, next) => {
  const { table } = req.params;

  // Whitelist allowed tables
  const allowedTables = ['listings', 'availability', 'cached_quotes'];
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const db = getDatabase();

    // Get row count
    const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };

    // Get rows (limit to 100 for performance)
    const rows = db.prepare(`SELECT * FROM ${table} LIMIT 100`).all();

    // Parse JSON columns if needed
    const parsedRows = rows.map((row: any) => {
      if (table === 'listings' && row.taxes) {
        try {
          row.taxes = JSON.parse(row.taxes);
        } catch (e) {
          // Keep as string if parsing fails
        }
      }
      if (table === 'cached_quotes' && row.breakdown) {
        try {
          row.breakdown = JSON.parse(row.breakdown);
        } catch (e) {
          // Keep as string if parsing fails
        }
      }
      return row;
    });

    return res.json({
      table,
      count: countResult.count,
      rows: parsedRows,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /admin/dashboard-data
 * Get dashboard statistics and bookings
 * Query params: period=past|future (default: future)
 */
router.get('/dashboard-data', async (req, res, next) => {
  try {
    const propertyId = config.guestyPropertyId;
    const period = (req.query.period as 'past' | 'future') || 'future';

    // Get listing info
    const listing = getListingById(propertyId);

    // Get stats from availability
    const stats = getDashboardStats(propertyId, 365, period);

    // Get conversion rate data
    const conversionData = getAllTimeConversionRate(propertyId);

    // Get detailed reservations
    const reservations = getReservationsByPeriod(propertyId, 365, period);

    // Transform reservations for frontend
    const bookings = reservations.map(r => ({
      reservationId: r.reservation_id,
      checkIn: r.check_in,
      checkOut: r.check_out,
      nights: r.nights_count,
      guestName: r.guest_name || 'Unknown Guest',
      guestsCount: r.guests_count || 0,
      status: r.status,
      confirmationCode: r.confirmation_code,
      source: r.source || r.platform || 'Unknown',
      totalPrice: r.host_payout || r.total_price || 0, // Use host_payout (includes fees & taxes)
      plannedArrival: r.planned_arrival,
      plannedDeparture: r.planned_departure,
    }));

    res.json({
      listing: {
        title: listing?.nickname || listing?.title || 'Unknown Property',
        currency: listing?.currency || 'EUR',
      },
      stats,
      conversion: {
        inquiriesCount: conversionData.inquiriesCount,
        confirmedCount: conversionData.confirmedCount,
        declinedCount: conversionData.declinedCount,
        canceledCount: conversionData.canceledCount,
        totalCount: conversionData.totalCount,
        conversionRate: conversionData.conversionRate,
      },
      bookings,
      period, // Include period in response so UI knows what's displayed
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/users
 * User management page
 */
router.get('/users', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>User Management - Guesty Calendar Admin</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 32px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
    }

    .section {
      background: white;
      padding: 25px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    button {
      background: #007bff;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 15px;
      font-weight: 500;
      transition: background 0.2s;
      margin-right: 10px;
      margin-bottom: 10px;
    }

    button:hover {
      background: #0056b3;
    }

    button.success {
      background: #28a745;
    }

    button.success:hover {
      background: #218838;
    }

    button.danger {
      background: #dc3545;
    }

    button.danger:hover {
      background: #c82333;
    }

    button.secondary {
      background: #6c757d;
    }

    button.secondary:hover {
      background: #5a6268;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }

    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }

    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #555;
    }

    tr:hover {
      background: #f8f9fa;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
    }

    .badge.active {
      background: #d4edda;
      color: #155724;
    }

    .badge.inactive {
      background: #f8d7da;
      color: #721c24;
    }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }

    .modal.show {
      display: flex;
    }

    .modal-content {
      background: white;
      padding: 30px;
      border-radius: 8px;
      max-width: 500px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
    }

    .modal-header {
      margin-bottom: 20px;
    }

    .modal-header h2 {
      color: #333;
      font-size: 24px;
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
    }

    input, select {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.2s;
    }

    input:focus, select:focus {
      outline: none;
      border-color: #007bff;
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .checkbox-group input[type="checkbox"] {
      width: auto;
    }

    .message {
      padding: 12px 16px;
      border-radius: 6px;
      margin: 15px 0;
      display: none;
    }

    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }

    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }

    .message.show {
      display: block;
    }

    .back-link {
      color: #007bff;
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    .actions-cell {
      white-space: nowrap;
    }

    .actions-cell button {
      padding: 6px 12px;
      font-size: 13px;
      margin-right: 5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>👥 User Management</h1>
        <a href="/admin" class="back-link">← Back to Dashboard</a>
      </div>
      <div>
        <button class="success" onclick="showAddUserModal()">+ Add New User</button>
        <a href="/auth/logout"><button class="secondary">Logout</button></a>
      </div>
    </div>

    <div id="message" class="message"></div>

    <div class="section">
      <div id="usersTable">Loading users...</div>
    </div>
  </div>

  <!-- Add/Edit User Modal -->
  <div id="userModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h2 id="modalTitle">Add User</h2>
      </div>
      <form id="userForm" onsubmit="saveUser(event)">
        <input type="hidden" id="userId">

        <div class="form-group">
          <label for="email">Email *</label>
          <input type="email" id="email" required>
        </div>

        <div class="form-group">
          <label for="name">Name *</label>
          <input type="text" id="name" required>
        </div>

        <div class="form-group">
          <label for="password">Password <span id="passwordHint">(min 8 characters) *</span></label>
          <input type="password" id="password" minlength="8">
        </div>

        <div class="form-group">
          <div class="checkbox-group">
            <input type="checkbox" id="isActive" checked>
            <label for="isActive" style="margin: 0;">Active</label>
          </div>
        </div>

        <div style="display: flex; gap: 10px; margin-top: 30px;">
          <button type="submit" class="success">Save</button>
          <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let users = [];

    function showMessage(text, type = 'success') {
      const msg = document.getElementById('message');
      msg.textContent = text;
      msg.className = 'message show ' + type;
      setTimeout(() => {
        msg.className = 'message';
      }, 5000);
    }

    async function loadUsers() {
      try {
        const res = await fetch('/api/admin-users');
        users = await res.json();

        const table = document.getElementById('usersTable');

        if (users.length === 0) {
          table.innerHTML = '<p style="color: #888;">No users found. Click "Add New User" to create one.</p>';
          return;
        }

        table.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Email</th>
                <th>Name</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              \${users.map(user => \`
                <tr>
                  <td>\${user.id}</td>
                  <td>\${user.email}</td>
                  <td>\${user.name}</td>
                  <td><span class="badge \${user.is_active ? 'active' : 'inactive'}">\${user.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td>\${new Date(user.created_at).toLocaleDateString()}</td>
                  <td class="actions-cell">
                    <button onclick="editUser(\${user.id})">Edit</button>
                    <button class="danger" onclick="deleteUser(\${user.id}, '\${user.email}')">Delete</button>
                  </td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        document.getElementById('usersTable').innerHTML = \`<p style="color: #dc3545;">Failed to load users: \${error.message}</p>\`;
      }
    }

    function showAddUserModal() {
      document.getElementById('modalTitle').textContent = 'Add User';
      document.getElementById('userId').value = '';
      document.getElementById('email').value = '';
      document.getElementById('name').value = '';
      document.getElementById('password').value = '';
      document.getElementById('password').required = true;
      document.getElementById('passwordHint').textContent = '(min 8 characters) *';
      document.getElementById('isActive').checked = true;
      document.getElementById('userModal').classList.add('show');
    }

    function editUser(id) {
      const user = users.find(u => u.id === id);
      if (!user) return;

      document.getElementById('modalTitle').textContent = 'Edit User';
      document.getElementById('userId').value = user.id;
      document.getElementById('email').value = user.email;
      document.getElementById('name').value = user.name;
      document.getElementById('password').value = '';
      document.getElementById('password').required = false;
      document.getElementById('passwordHint').textContent = '(leave blank to keep current)';
      document.getElementById('isActive').checked = user.is_active;
      document.getElementById('userModal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('userModal').classList.remove('show');
    }

    async function saveUser(event) {
      event.preventDefault();

      const userId = document.getElementById('userId').value;
      const email = document.getElementById('email').value;
      const name = document.getElementById('name').value;
      const password = document.getElementById('password').value;
      const isActive = document.getElementById('isActive').checked;

      try {
        let res;
        if (userId) {
          // Update existing user
          const data = { email, name, is_active: isActive };
          if (password) {
            data.password = password;
          }
          res = await fetch(\`/api/admin-users/\${userId}\`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
        } else {
          // Create new user
          res = await fetch('/api/admin-users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, name, password, is_active: isActive }),
          });
        }

        if (res.ok) {
          showMessage(\`User \${userId ? 'updated' : 'created'} successfully!\`, 'success');
          closeModal();
          loadUsers();
        } else {
          const error = await res.json();
          showMessage(\`Error: \${error.error || 'Unknown error'}\`, 'error');
        }
      } catch (error) {
        showMessage(\`Error: \${error.message}\`, 'error');
      }
    }

    async function deleteUser(id, email) {
      if (!confirm(\`Are you sure you want to delete user "\${email}"?\`)) {
        return;
      }

      try {
        const res = await fetch(\`/api/admin-users/\${id}\`, {
          method: 'DELETE',
        });

        if (res.ok) {
          showMessage('User deleted successfully!', 'success');
          loadUsers();
        } else {
          const error = await res.json();
          showMessage(\`Error: \${error.error || 'Unknown error'}\`, 'error');
        }
      } catch (error) {
        showMessage(\`Error: \${error.message}\`, 'error');
      }
    }

    // Load users on page load
    loadUsers();
  </script>
</body>
</html>
  `);
});

/**
 * GET /admin/analytics-data
 * Get analytics data for the dashboard
 */
router.get('/analytics-data', (_req, res, next) => {
  try {
    const enabled = ga4Client.isEnabled();

    if (!enabled) {
      return res.json({
        enabled: false,
        hasData: false,
        summary: null,
        topPages: [],
        lastSync: null,
      });
    }

    const hasData = hasAnalyticsData();
    const summary = hasData ? getAnalyticsSummary(30) : null;
    const topPages = hasData ? getLatestTopPages() : [];
    const lastSync = getLastSyncTime();

    return res.json({
      enabled,
      hasData,
      summary,
      topPages,
      lastSync,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /admin/sync/analytics
 * Trigger manual analytics sync
 */
router.post('/sync/analytics', async (_req, res, next) => {
  try {
    logger.info('Manual analytics sync triggered via admin');
    const result = await syncAnalytics(30);

    res.json({
      success: result.success,
      recordsSynced: result.recordsSynced,
      topPagesUpdated: result.topPagesUpdated,
      durationMs: result.durationMs,
      error: result.error,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// DOCUMENT GENERATION ROUTES
// ============================================================================

/**
 * POST /admin/documents/generate
 * Generate a quote or invoice for a reservation
 */
router.post('/documents/generate', async (req, res, next) => {
  try {
    const { reservationId, documentType } = req.body;

    if (!reservationId) {
      res.status(400).json({ error: 'reservationId is required' });
      return;
    }

    if (!documentType || !['quote', 'invoice'].includes(documentType)) {
      res.status(400).json({ error: 'documentType must be "quote" or "invoice"' });
      return;
    }

    logger.info({ reservationId, documentType }, 'Document generation requested');

    const result = await createOrGetDocument({
      reservationId,
      documentType,
    });

    // Send PDF as response
    const filename = documentType === 'quote'
      ? `Angebot_${result.document.documentNumber}.pdf`
      : `Rechnung_${result.document.documentNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Document-Number', result.document.documentNumber);
    res.setHeader('X-Document-Is-New', result.isNew ? 'true' : 'false');
    res.send(result.pdf);
  } catch (error) {
    logger.error({ error }, 'Failed to generate document');
    next(error);
  }
});

/**
 * POST /admin/documents/refresh
 * Refresh document with fresh data from Guesty API (keeps document number)
 */
router.post('/documents/refresh', async (req, res, next) => {
  try {
    const { reservationId, documentType } = req.body;

    if (!reservationId) {
      res.status(400).json({ error: 'reservationId is required' });
      return;
    }

    if (!documentType || !['quote', 'invoice'].includes(documentType)) {
      res.status(400).json({ error: 'documentType must be "quote" or "invoice"' });
      return;
    }

    logger.info({ reservationId, documentType }, 'Document refresh requested');

    const result = await refreshDocument({
      reservationId,
      documentType,
    });

    // Send PDF as response
    const filename = documentType === 'quote'
      ? `Angebot_${result.document.documentNumber}.pdf`
      : `Rechnung_${result.document.documentNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Document-Number', result.document.documentNumber);
    res.setHeader('X-Document-Is-New', result.isNew ? 'true' : 'false');
    res.send(result.pdf);
  } catch (error) {
    logger.error({ error }, 'Failed to refresh document');
    next(error);
  }
});

/**
 * GET /admin/documents/list
 * List all generated documents
 */
router.get('/documents/list', (_req, res, next) => {
  try {
    const documents = listDocuments(undefined, 100);

    res.json({
      success: true,
      documents: documents.map(doc => ({
        id: doc.id,
        documentNumber: doc.documentNumber,
        documentType: doc.documentType,
        reservationId: doc.reservationId,
        customerName: doc.customer.name,
        customerCompany: doc.customer.company,
        checkIn: doc.checkIn,
        checkOut: doc.checkOut,
        total: doc.total / 100, // Convert cents to euros
        currency: doc.currency,
        createdAt: doc.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin/documents/reservation/:reservationId
 * Get all documents for a specific reservation
 */
router.get('/documents/reservation/:reservationId', (req, res, next) => {
  try {
    const { reservationId } = req.params;
    const documents = getDocumentsByReservation(reservationId);

    res.json({
      success: true,
      documents: documents.map(doc => ({
        id: doc.id,
        documentNumber: doc.documentNumber,
        documentType: doc.documentType,
        total: doc.total / 100,
        currency: doc.currency,
        createdAt: doc.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
