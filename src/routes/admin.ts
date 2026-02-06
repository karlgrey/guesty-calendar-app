/**
 * Admin Routes
 *
 * Backend admin interface for database viewing, manual sync triggers, and health monitoring.
 */

import express from 'express';
import { getDatabase } from '../db/index.js';
import { syncListing } from '../jobs/sync-listing.js';
import { syncAvailability } from '../jobs/sync-availability.js';
import { runETLJob, runETLJobForProperty } from '../jobs/etl-job.js';
import { getSchedulerStatus } from '../jobs/scheduler.js';
import { config } from '../config/index.js';
import { getAllProperties, getPropertyBySlug, getDefaultProperty } from '../config/properties.js';
import logger from '../utils/logger.js';
import { getDashboardStats, getAllTimeConversionRate } from '../repositories/availability-repository.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getReservationsByPeriod } from '../repositories/reservation-repository.js';
import { getAnalyticsSummary, getLatestTopPages, getLastSyncTime, hasAnalyticsData, getDailyAnalytics } from '../repositories/analytics-repository.js';
import { syncAnalytics } from '../jobs/sync-analytics.js';
import { ga4Client } from '../services/ga4-client.js';
import { createOrGetDocument, refreshDocument } from '../services/document-service.js';
import { getDocumentsByReservation, getDocumentByReservation, listDocuments, getDocumentSequenceInfo, setDocumentSequenceNumber } from '../repositories/document-repository.js';

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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;0,9..144,700;1,9..144,300&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">

  <style>
    :root {
      --color-cream: #faf8f5;
      --color-sand: #f4f1ed;
      --color-stone: #e8e4df;
      --color-charcoal: #2a2a2a;
      --color-warm-gray: #6b6560;
      --color-forest: #2d5a3d;
      --color-forest-light: #3d7a52;
      --color-terracotta: #c75b3c;
      --color-terracotta-light: #d67456;
      --color-amber: #d4a574;
      --color-sage: #8a9a7b;
      --color-red: #c44536;
      --color-red-dark: #a13828;

      --font-display: 'Fraunces', serif;
      --font-body: 'Manrope', sans-serif;
      --font-mono: 'SF Mono', 'Monaco', 'Consolas', monospace;

      --shadow-sm: 0 2px 8px rgba(42, 42, 42, 0.04);
      --shadow-md: 0 4px 16px rgba(42, 42, 42, 0.08);
      --shadow-lg: 0 8px 32px rgba(42, 42, 42, 0.12);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-body);
      background: var(--color-cream);
      padding: clamp(20px, 4vw, 48px);
      line-height: 1.65;
      color: var(--color-charcoal);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    h1 {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: clamp(32px, 5vw, 56px);
      line-height: 1.1;
      color: var(--color-charcoal);
      margin-bottom: 48px;
      letter-spacing: -0.02em;
    }

    h2 {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: clamp(24px, 3vw, 36px);
      line-height: 1.2;
      color: var(--color-charcoal);
      margin: 0 0 24px;
      letter-spacing: -0.01em;
      position: relative;
      padding-bottom: 16px;
    }

    h2::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      width: 64px;
      height: 3px;
      background: linear-gradient(90deg, var(--color-forest), var(--color-terracotta));
      border-radius: 2px;
    }

    h3 {
      font-family: var(--font-body);
      font-weight: 600;
      font-size: 13px;
      color: var(--color-warm-gray);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .section {
      background: white;
      padding: clamp(24px, 4vw, 40px);
      margin-bottom: 32px;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      border: 1px solid var(--color-stone);
      transition: box-shadow 0.3s ease, transform 0.3s ease;
    }

    .section:hover {
      box-shadow: var(--shadow-lg);
      transform: translateY(-2px);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }

    .card {
      background: linear-gradient(135deg, var(--color-sand) 0%, var(--color-cream) 100%);
      padding: 28px;
      border-radius: var(--radius-md);
      border: 1px solid rgba(107, 101, 96, 0.1);
      position: relative;
      overflow: hidden;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--card-accent, var(--color-forest));
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .card:hover::before {
      opacity: 1;
    }

    .card:hover {
      transform: translateX(4px);
      box-shadow: var(--shadow-sm);
    }

    .card h3 {
      position: relative;
      z-index: 1;
    }

    .card .value {
      font-family: var(--font-display);
      font-size: clamp(32px, 4vw, 42px);
      font-weight: 600;
      color: var(--color-charcoal);
      margin: 12px 0 8px;
      line-height: 1.1;
      letter-spacing: -0.02em;
    }

    .card .subvalue {
      font-size: 14px;
      color: var(--color-warm-gray);
      margin-top: 8px;
      line-height: 1.4;
    }

    button {
      font-family: var(--font-body);
      background: var(--color-forest);
      color: white;
      border: none;
      padding: 14px 28px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      margin-right: 12px;
      margin-bottom: 12px;
      letter-spacing: 0.01em;
      position: relative;
      overflow: hidden;
    }

    button::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 100%);
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    button:hover::before {
      opacity: 1;
    }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(45, 90, 61, 0.3);
    }

    button:active {
      transform: translateY(0);
    }

    button:disabled {
      background: var(--color-stone);
      color: var(--color-warm-gray);
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    button.success {
      background: var(--color-forest);
    }

    button.success:hover {
      box-shadow: 0 4px 12px rgba(45, 90, 61, 0.3);
    }

    button.danger {
      background: var(--color-red);
    }

    button.danger:hover {
      background: var(--color-red-dark);
      box-shadow: 0 4px 12px rgba(196, 69, 54, 0.3);
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .status::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .status.running {
      background: rgba(45, 90, 61, 0.1);
      color: var(--color-forest);
    }

    .status.stopped {
      background: rgba(196, 69, 54, 0.1);
      color: var(--color-red);
    }

    /* Document buttons */
    .doc-btn {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 6px;
      transition: all 0.2s ease;
      letter-spacing: 0.02em;
    }

    .doc-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    .quote-btn {
      background: linear-gradient(135deg, var(--color-sage), #6d8363);
      color: white;
    }

    .quote-btn:hover:not(:disabled) {
      box-shadow: 0 2px 8px rgba(138, 154, 123, 0.4);
      transform: translateY(-1px);
    }

    .invoice-btn {
      background: linear-gradient(135deg, var(--color-terracotta), var(--color-terracotta-light));
      color: white;
    }

    .invoice-btn:hover:not(:disabled) {
      box-shadow: 0 2px 8px rgba(199, 91, 60, 0.4);
      transform: translateY(-1px);
    }

    .refresh-btn {
      background: var(--color-stone);
      color: var(--color-warm-gray);
      font-size: 11px;
      padding: 6px 10px;
    }

    .refresh-btn:hover:not(:disabled) {
      background: var(--color-warm-gray);
      color: white;
      transform: translateY(-1px);
    }

    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin-top: 20px;
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    th, td {
      padding: 16px 18px;
      text-align: left;
      border-bottom: 1px solid var(--color-stone);
    }

    th {
      background: linear-gradient(180deg, var(--color-sand), var(--color-cream));
      font-weight: 700;
      font-size: 13px;
      color: var(--color-charcoal);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 2px solid var(--color-stone);
    }

    td {
      font-size: 15px;
      background: white;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr {
      transition: background-color 0.2s ease, transform 0.2s ease;
    }

    tbody tr:hover {
      background: var(--color-cream) !important;
      transform: scale(1.005);
    }

    tbody tr:hover td {
      background: transparent;
    }

    pre {
      background: var(--color-sand);
      padding: 20px;
      border-radius: var(--radius-md);
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.6;
      font-family: var(--font-mono);
      border: 1px solid var(--color-stone);
    }

    .message {
      padding: 16px 20px;
      border-radius: var(--radius-md);
      margin: 20px 0;
      display: none;
      font-weight: 500;
      border-left: 4px solid;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message.success {
      background: rgba(45, 90, 61, 0.08);
      color: var(--color-forest);
      border-left-color: var(--color-forest);
    }

    .message.error {
      background: rgba(196, 69, 54, 0.08);
      color: var(--color-red);
      border-left-color: var(--color-red);
    }

    .message.show {
      display: block;
    }

    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top: 2px solid white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-left: 8px;
      vertical-align: middle;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .actions {
      margin-top: 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 48px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--color-stone);
    }

    .header h1 {
      margin-bottom: 0;
    }

    button.secondary {
      background: var(--color-warm-gray);
    }

    button.secondary:hover {
      background: var(--color-charcoal);
      box-shadow: 0 4px 12px rgba(42, 42, 42, 0.2);
    }

    .property-selector {
      font-family: var(--font-body);
      font-size: 16px;
      font-weight: 600;
      padding: 10px 16px;
      border: 2px solid var(--color-stone);
      border-radius: var(--radius-sm);
      background: var(--color-sand);
      color: var(--color-charcoal);
      cursor: pointer;
      min-width: 200px;
      transition: all 0.2s ease;
    }

    .property-selector:hover {
      border-color: var(--color-forest);
    }

    .property-selector:focus {
      outline: none;
      border-color: var(--color-forest);
      box-shadow: 0 0 0 3px rgba(45, 90, 61, 0.1);
    }

    /* Custom color accents for specific cards */
    .card[style*="border-left-color: #28a745"],
    .card[style*="border-left-color: rgb(40, 167, 69)"] {
      --card-accent: var(--color-forest);
    }

    .card[style*="border-left-color: #17a2b8"],
    .card[style*="border-left-color: rgb(23, 162, 184)"] {
      --card-accent: var(--color-sage);
    }

    .card[style*="border-left-color: #ffc107"],
    .card[style*="border-left-color: rgb(255, 193, 7)"] {
      --card-accent: var(--color-amber);
    }

    .card[style*="border-left-color: #6c757d"],
    .card[style*="border-left-color: rgb(108, 117, 125)"] {
      --card-accent: var(--color-warm-gray);
    }

    .card[style*="border-left-color: #007bff"],
    .card[style*="border-left-color: rgb(0, 123, 255)"] {
      --card-accent: var(--color-forest);
    }

    .card[style*="border-left-color: #9b59b6"],
    .card[style*="border-left-color: rgb(155, 89, 182)"] {
      --card-accent: var(--color-terracotta);
    }

    .card[style*="border-left-color: #4285f4"],
    .card[style*="border-left-color: rgb(66, 133, 244)"] {
      --card-accent: var(--color-sage);
    }

    .card[style*="border-left-color: #34a853"],
    .card[style*="border-left-color: rgb(52, 168, 83)"] {
      --card-accent: var(--color-forest);
    }

    .card[style*="border-left-color: #fbbc05"],
    .card[style*="border-left-color: rgb(251, 188, 5)"] {
      --card-accent: var(--color-amber);
    }

    .card[style*="border-left-color: #ea4335"],
    .card[style*="border-left-color: rgb(234, 67, 53)"] {
      --card-accent: var(--color-terracotta);
    }

    /* Input styling */
    input[type="number"],
    input[type="text"],
    input[type="email"] {
      font-family: var(--font-body);
      padding: 10px 14px;
      border: 2px solid var(--color-stone);
      border-radius: var(--radius-sm);
      font-size: 15px;
      transition: all 0.2s ease;
      background: white;
    }

    input:focus {
      outline: none;
      border-color: var(--color-forest);
      box-shadow: 0 0 0 3px rgba(45, 90, 61, 0.1);
    }

    label {
      font-weight: 600;
      color: var(--color-charcoal);
      font-size: 14px;
    }

    /* Responsive */
    @media (max-width: 768px) {
      body {
        padding: 16px;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .header {
        flex-direction: column;
        align-items: flex-start;
        gap: 20px;
      }

      table {
        font-size: 13px;
      }

      th, td {
        padding: 12px;
      }
    }

    /* Analytics Trend Chart */
    .trend-chart-container {
      background: white;
      border-radius: var(--radius-md);
      padding: 24px;
      box-shadow: var(--shadow-sm);
      margin-top: 24px;
      margin-bottom: 24px;
    }

    .trend-chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .trend-chart-header h3 {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 18px;
      color: var(--color-charcoal);
      margin: 0;
    }

    .period-selector {
      display: flex;
      gap: 8px;
    }

    .period-btn {
      padding: 8px 16px;
      border: 1px solid var(--color-stone);
      background: white;
      border-radius: var(--radius-sm);
      font-family: var(--font-body);
      font-size: 13px;
      font-weight: 500;
      color: var(--color-warm-gray);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .period-btn:hover {
      border-color: var(--color-forest);
      color: var(--color-forest);
    }

    .period-btn.active {
      background: var(--color-forest);
      border-color: var(--color-forest);
      color: white;
    }

    .chart-wrapper {
      position: relative;
      height: 300px;
    }

    @media (max-width: 768px) {
      .trend-chart-header {
        flex-direction: column;
        align-items: flex-start;
      }

      .chart-wrapper {
        height: 250px;
      }
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: flex; align-items: center; gap: 20px;">
        <h1 style="margin-bottom: 0;">🛠️ Admin</h1>
        <select id="propertySelector" class="property-selector" onchange="switchProperty(this.value)">
          <option value="">Loading properties...</option>
        </select>
      </div>
      <div style="display: flex; gap: 10px;">
        <a href="/admin/system"><button class="secondary">System</button></a>
        <a href="/auth/logout"><button class="secondary">Logout</button></a>
      </div>
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

    <!-- Document Sequence Management -->
    <div class="section">
      <h2>📄 Dokumenten-Verwaltung</h2>
      <div class="grid" style="grid-template-columns: 1fr 1fr;">
        <div class="card">
          <h3>Letzte Rechnung</h3>
          <div id="lastInvoiceInfo">Lädt...</div>
        </div>
        <div class="card">
          <h3>Letztes Angebot</h3>
          <div id="lastQuoteInfo">Lädt...</div>
        </div>
      </div>
      <div class="card" style="margin-top: 20px;">
        <h3>Nächste Dokumentennummer</h3>
        <div id="nextNumberInfo" style="margin-bottom: 15px; font-size: 18px; font-weight: bold; color: #2563eb;">
          Lädt...
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <label for="manualSequence" style="font-weight: 500;">Letzte Nummer manuell setzen:</label>
          <input
            type="number"
            id="manualSequence"
            placeholder="z.B. 17"
            min="0"
            max="99999"
            style="padding: 8px; border: 1px solid #ddd; border-radius: 4px; width: 120px;"
          />
          <button onclick="updateSequence()" class="success" id="updateSequenceBtn">💾 Speichern</button>
        </div>
        <div id="sequenceMessage" style="margin-top: 10px; font-size: 14px;"></div>
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

      <!-- Trend Chart -->
      <div class="trend-chart-container" id="trendChartContainer" style="display: none;">
        <div class="trend-chart-header">
          <h3>📊 Traffic Trend</h3>
          <div class="period-selector">
            <button class="period-btn" data-days="7" onclick="loadAnalyticsTrend(7)">7D</button>
            <button class="period-btn" data-days="14" onclick="loadAnalyticsTrend(14)">14D</button>
            <button class="period-btn active" data-days="30" onclick="loadAnalyticsTrend(30)">30D</button>
            <button class="period-btn" data-days="90" onclick="loadAnalyticsTrend(90)">3M</button>
            <button class="period-btn" data-days="180" onclick="loadAnalyticsTrend(180)">6M</button>
          </div>
        </div>
        <div class="chart-wrapper">
          <canvas id="trendChart"></canvas>
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

  </div>

  <script>
    let currentPeriod = 'future'; // Track current period
    let currentProperty = null; // Track current property slug
    let propertiesMap = {}; // Track property metadata

    // Load available properties for selector
    async function loadProperties() {
      try {
        const res = await fetch('/admin/properties');
        const data = await res.json();
        const selector = document.getElementById('propertySelector');

        if (data.properties && data.properties.length > 0) {
          selector.innerHTML = data.properties.map(p =>
            \`<option value="\${p.slug}" \${p.isDefault ? 'selected' : ''}>\${p.name}</option>\`
          ).join('');
          currentProperty = data.defaultSlug || data.properties[0].slug;
          // Build lookup map for property metadata
          data.properties.forEach(p => { propertiesMap[p.slug] = p; });
        } else {
          selector.innerHTML = '<option value="">No properties configured</option>';
        }
      } catch (error) {
        console.error('Failed to load properties:', error);
        document.getElementById('propertySelector').innerHTML = '<option value="">Error loading</option>';
      }
    }

    // Switch to a different property
    function switchProperty(slug) {
      if (slug && slug !== currentProperty) {
        currentProperty = slug;
        loadDashboard();
        updateAnalyticsVisibility();
      }
    }

    // Show/hide analytics based on property GA4 config
    function updateAnalyticsVisibility() {
      const analyticsSection = document.getElementById('analyticsSection');
      const propertyConfig = propertiesMap[currentProperty];
      if (propertyConfig && propertyConfig.ga4Enabled) {
        analyticsSection.style.display = 'block';
        loadAnalytics();
      } else {
        analyticsSection.style.display = 'none';
      }
    }

    function showMessage(text, type = 'success') {
      const msg = document.getElementById('message');
      msg.textContent = text;
      msg.className = 'message show ' + type;
      setTimeout(() => {
        msg.className = 'message';
      }, 5000);
    }

    // Load document sequence information
    async function loadDocumentSequence() {
      console.log('[Document Sequence] Starting to load...');
      try {
        const response = await fetch('/admin/api/document-sequence');
        console.log('[Document Sequence] Response received:', response.status);
        const result = await response.json();
        console.log('[Document Sequence] Result:', result);

        if (result.success) {
          const { lastNumber, nextNumber, lastInvoice, lastQuote } = result.data;

          // Update last invoice info
          const lastInvoiceEl = document.getElementById('lastInvoiceInfo');
          if (lastInvoice) {
            const customerDisplay = lastInvoice.customerCompany
              ? \`\${lastInvoice.customerCompany}<br/><small>\${lastInvoice.customerName || 'N/A'}</small>\`
              : lastInvoice.customerName || 'N/A';
            lastInvoiceEl.innerHTML = \`
              <div style="margin-bottom: 8px;"><strong>\${lastInvoice.documentNumber}</strong></div>
              <div style="font-size: 14px; color: #666;">
                \${customerDisplay}<br/>
                Check-in: \${new Date(lastInvoice.checkIn).toLocaleDateString('de-DE')}<br/>
                Gesamt: €\${lastInvoice.total.toFixed(2)}<br/>
                <small>Erstellt: \${new Date(lastInvoice.createdAt).toLocaleString('de-DE')}</small>
              </div>
            \`;
          } else {
            lastInvoiceEl.innerHTML = '<div style="color: #999;">Keine Rechnung vorhanden</div>';
          }

          // Update last quote info
          const lastQuoteEl = document.getElementById('lastQuoteInfo');
          if (lastQuote) {
            const customerDisplay = lastQuote.customerCompany
              ? \`\${lastQuote.customerCompany}<br/><small>\${lastQuote.customerName || 'N/A'}</small>\`
              : lastQuote.customerName || 'N/A';
            lastQuoteEl.innerHTML = \`
              <div style="margin-bottom: 8px;"><strong>\${lastQuote.documentNumber}</strong></div>
              <div style="font-size: 14px; color: #666;">
                \${customerDisplay}<br/>
                Check-in: \${new Date(lastQuote.checkIn).toLocaleDateString('de-DE')}<br/>
                Gesamt: €\${lastQuote.total.toFixed(2)}<br/>
                <small>Erstellt: \${new Date(lastQuote.createdAt).toLocaleString('de-DE')}</small>
              </div>
            \`;
          } else {
            lastQuoteEl.innerHTML = '<div style="color: #999;">Kein Angebot vorhanden</div>';
          }

          // Update next number info
          const year = new Date().getFullYear();
          document.getElementById('nextNumberInfo').innerHTML = \`
            Nächstes Angebot: <span style="color: #059669;">A-\${year}-\${String(nextNumber).padStart(4, '0')}</span> &nbsp;|&nbsp;
            Nächste Rechnung: <span style="color: #2563eb;">\${year}-\${String(nextNumber).padStart(4, '0')}</span>
            <br/><small style="color: #666; font-weight: normal;">Aktuelle letzte Nummer: \${lastNumber}</small>
          \`;

          // Set input field to current last number
          document.getElementById('manualSequence').value = lastNumber;
        }
      } catch (error) {
        console.error('[Document Sequence] Failed to load:', error);
        const el = document.getElementById('nextNumberInfo');
        if (el) {
          el.innerHTML = '<span style="color: red;">Fehler beim Laden</span>';
        } else {
          console.error('[Document Sequence] Element nextNumberInfo not found!');
        }
      }
    }

    // Update document sequence
    async function updateSequence() {
      const input = document.getElementById('manualSequence');
      const newNumber = parseInt(input.value);
      const btn = document.getElementById('updateSequenceBtn');
      const msgEl = document.getElementById('sequenceMessage');

      if (isNaN(newNumber) || newNumber < 0) {
        msgEl.innerHTML = '<span style="color: red;">Ungültige Nummer</span>';
        return;
      }

      btn.disabled = true;
      btn.textContent = '💾 Speichert...';
      msgEl.innerHTML = '';

      try {
        const year = new Date().getFullYear();
        const response = await fetch('/admin/api/document-sequence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year, lastNumber: newNumber })
        });

        const result = await response.json();

        if (result.success) {
          msgEl.innerHTML = \`<span style="color: green;">✓ \${result.message}</span>\`;
          showMessage('Dokumentennummer erfolgreich aktualisiert!', 'success');
          // Reload sequence info
          await loadDocumentSequence();
        } else {
          msgEl.innerHTML = \`<span style="color: red;">✗ \${result.error}</span>\`;
        }
      } catch (error) {
        console.error('Failed to update sequence:', error);
        msgEl.innerHTML = '<span style="color: red;">✗ Fehler beim Speichern</span>';
      } finally {
        btn.disabled = false;
        btn.textContent = '💾 Speichern';
      }
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
        const propertyParam = currentProperty ? \`&property=\${currentProperty}\` : '';
        const res = await fetch(\`/admin/dashboard-data?period=\${currentPeriod}\${propertyParam}\`);
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
                        \${booking.quoteNumber || 'A'}
                      </button>
                      <button class="doc-btn invoice-btn" onclick="generateDocument('\${booking.reservationId}', 'invoice')" title="Rechnung erstellen/laden">
                        \${booking.invoiceNumber || 'R'}
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

        // Load trend chart with default 30 days
        loadAnalyticsTrend(30);
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

    // Analytics trend chart
    let trendChart = null;

    async function loadAnalyticsTrend(days) {
      try {
        const res = await fetch(\`/admin/analytics-trend-data?days=\${days}\`);
        const data = await res.json();

        const container = document.getElementById('trendChartContainer');

        if (!data.enabled || data.data.length === 0) {
          container.style.display = 'none';
          return;
        }

        container.style.display = 'block';

        // Update active button state
        document.querySelectorAll('.period-btn').forEach(btn => {
          btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
        });

        const ctx = document.getElementById('trendChart').getContext('2d');

        // Prepare chart data
        const labels = data.data.map(d => {
          const date = new Date(d.date);
          return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        });

        const pageviews = data.data.map(d => d.pageviews);
        const users = data.data.map(d => d.users);

        // Destroy existing chart if any
        if (trendChart) {
          trendChart.destroy();
        }

        // Create new chart
        trendChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Pageviews',
                data: pageviews,
                borderColor: '#4285f4',
                backgroundColor: 'rgba(66, 133, 244, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointRadius: days <= 14 ? 4 : 2,
                pointHoverRadius: 6,
              },
              {
                label: 'Users',
                data: users,
                borderColor: '#34a853',
                backgroundColor: 'rgba(52, 168, 83, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointRadius: days <= 14 ? 4 : 2,
                pointHoverRadius: 6,
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              intersect: false,
              mode: 'index',
            },
            plugins: {
              legend: {
                position: 'top',
                align: 'end',
                labels: {
                  usePointStyle: true,
                  padding: 20,
                  font: {
                    family: "'Manrope', sans-serif",
                    size: 12,
                  }
                }
              },
              tooltip: {
                backgroundColor: 'rgba(42, 42, 42, 0.9)',
                titleFont: {
                  family: "'Manrope', sans-serif",
                  size: 13,
                },
                bodyFont: {
                  family: "'Manrope', sans-serif",
                  size: 12,
                },
                padding: 12,
                cornerRadius: 8,
              }
            },
            scales: {
              x: {
                grid: {
                  display: false,
                },
                ticks: {
                  font: {
                    family: "'Manrope', sans-serif",
                    size: 11,
                  },
                  color: '#6b6560',
                  maxRotation: 0,
                  maxTicksLimit: days <= 14 ? days : 10,
                }
              },
              y: {
                beginAtZero: true,
                grid: {
                  color: 'rgba(232, 228, 223, 0.8)',
                },
                ticks: {
                  font: {
                    family: "'Manrope', sans-serif",
                    size: 11,
                  },
                  color: '#6b6560',
                }
              }
            }
          }
        });

      } catch (error) {
        console.error('Failed to load analytics trend:', error);
        document.getElementById('trendChartContainer').style.display = 'none';
      }
    }

    // Load initial data
    console.log('[INIT] Loading initial data...');
    // Load properties first, then dashboard and analytics
    loadProperties().then(() => {
      loadDashboard();
      updateAnalyticsVisibility();
    });
    loadDocumentSequence();
    console.log('[INIT] All load functions called');

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
 * GET /admin/system
 * System & infrastructure admin page
 */
router.get('/system', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System - Guesty Calendar Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;0,9..144,700;1,9..144,300&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --color-cream: #faf8f5;
      --color-sand: #f4f1ed;
      --color-stone: #e8e4df;
      --color-charcoal: #2a2a2a;
      --color-warm-gray: #6b6560;
      --color-forest: #2d5a3d;
      --color-forest-light: #3d7a52;
      --color-terracotta: #c75b3c;
      --color-terracotta-light: #d67456;
      --color-amber: #d4a574;
      --color-sage: #8a9a7b;
      --color-red: #c44536;
      --color-red-dark: #a13828;
      --font-display: 'Fraunces', serif;
      --font-body: 'Manrope', sans-serif;
      --font-mono: 'SF Mono', 'Monaco', 'Consolas', monospace;
      --shadow-sm: 0 2px 8px rgba(42, 42, 42, 0.04);
      --shadow-md: 0 4px 16px rgba(42, 42, 42, 0.08);
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-body); background: var(--color-cream); color: var(--color-charcoal); line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 30px 20px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid var(--color-stone); }
    .header h1 { font-family: var(--font-display); font-size: 28px; font-weight: 600; color: var(--color-charcoal); }
    .section { background: white; border-radius: var(--radius-lg); padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow-sm); border: 1px solid var(--color-stone); }
    .section h2 { font-family: var(--font-display); font-size: 20px; font-weight: 600; margin-bottom: 20px; color: var(--color-charcoal); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .card { background: var(--color-cream); padding: 20px; border-radius: var(--radius-md); border-left: 4px solid var(--color-forest); }
    .card h3 { font-family: var(--font-body); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-warm-gray); margin-bottom: 8px; font-weight: 600; }
    .card .value { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--color-charcoal); }
    .card .subvalue { font-size: 13px; color: var(--color-warm-gray); margin-top: 4px; }
    button { padding: 10px 20px; border: none; border-radius: var(--radius-sm); cursor: pointer; font-size: 14px; font-family: var(--font-body); font-weight: 600; transition: all 0.2s; background: var(--color-forest); color: white; }
    button:hover { background: var(--color-forest-light); transform: translateY(-1px); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    button.secondary { background: var(--color-sand); color: var(--color-charcoal); border: 1px solid var(--color-stone); }
    button.secondary:hover { background: var(--color-stone); }
    button.success { background: var(--color-forest); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .message { padding: 12px 16px; border-radius: var(--radius-sm); margin-bottom: 20px; display: none; font-weight: 500; }
    .message.success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; display: block; }
    .message.error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--color-stone); }
    th { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-warm-gray); background: var(--color-cream); }
    .status { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status.running { background: #ecfdf5; color: #065f46; }
    .status.stopped { background: #fef2f2; color: #991b1b; }
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 0.8s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .property-selector { padding: 8px 12px; border: 1px solid var(--color-stone); border-radius: var(--radius-sm); font-family: var(--font-body); font-size: 14px; background: white; color: var(--color-charcoal); cursor: pointer; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: flex; align-items: center; gap: 20px;">
        <h1 style="margin-bottom: 0;">System</h1>
        <select id="propertySelector" class="property-selector" onchange="switchProperty(this.value)">
          <option value="">Loading properties...</option>
        </select>
      </div>
      <div style="display: flex; gap: 10px;">
        <a href="/admin"><button class="secondary">Dashboard</button></a>
        <a href="/auth/logout"><button class="secondary">Logout</button></a>
      </div>
    </div>

    <div id="message" class="message"></div>

    <!-- System Health -->
    <div class="section">
      <h2>System Health</h2>
      <div class="grid" id="healthGrid">
        <div class="card">
          <h3>Status</h3>
          <div class="value">Loading...</div>
        </div>
      </div>
    </div>

    <!-- ETL Scheduler -->
    <div class="section">
      <h2>ETL Scheduler</h2>
      <div id="schedulerStatus">Loading...</div>
    </div>

    <!-- Manual Sync -->
    <div class="section">
      <h2>Manual Data Sync</h2>
      <p style="color: var(--color-warm-gray); margin-bottom: 20px;">Trigger immediate data refresh from Guesty API</p>
      <div class="actions">
        <button onclick="syncAll(event)">Sync All (Listing + Availability)</button>
        <button onclick="syncListing(event)">Sync Listing Only</button>
        <button onclick="syncAvailability(event)">Sync Availability Only</button>
      </div>
    </div>

    <!-- User Management -->
    <div class="section">
      <h2>User Management</h2>
      <p style="color: var(--color-warm-gray); margin-bottom: 20px;">Manage admin users who can access this panel</p>
      <div class="actions">
        <button onclick="window.location.href='/admin/users'">Manage Users</button>
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
  </div>

  <script>
    let currentProperty = null;

    function showMessage(text, type) {
      const msg = document.getElementById('message');
      msg.textContent = text;
      msg.className = 'message ' + type;
      setTimeout(() => { msg.style.display = 'none'; msg.className = 'message'; }, 5000);
    }

    async function loadProperties() {
      try {
        const res = await fetch('/admin/properties');
        const data = await res.json();
        const selector = document.getElementById('propertySelector');
        selector.innerHTML = data.properties.map(p =>
          \`<option value="\${p.slug}" \${p.isDefault ? 'selected' : ''}>\${p.name}</option>\`
        ).join('');
        currentProperty = data.defaultSlug || data.properties[0]?.slug;
      } catch (error) {
        console.error('Failed to load properties:', error);
      }
    }

    function switchProperty(slug) {
      currentProperty = slug;
    }

    async function loadHealth() {
      try {
        const res = await fetch('/admin/health');
        const data = await res.json();

        const grid = document.getElementById('healthGrid');

        let lastSyncHtml = '';
        if (data.scheduler.lastSuccessfulRun) {
          const successDate = new Date(data.scheduler.lastSuccessfulRun);
          lastSyncHtml = \`
            <div class="value" style="color: #28a745;">\${successDate.toLocaleTimeString()}</div>
            <div class="subvalue" style="color: #28a745;">Success · \${successDate.toLocaleDateString()}</div>
          \`;
        } else if (data.scheduler.lastFailedRun) {
          const failDate = new Date(data.scheduler.lastFailedRun);
          lastSyncHtml = \`
            <div class="value" style="color: #dc3545;">\${failDate.toLocaleTimeString()}</div>
            <div class="subvalue" style="color: #dc3545;">Failed · \${failDate.toLocaleDateString()}</div>
          \`;
        } else {
          lastSyncHtml = \`<div class="value">Never</div><div class="subvalue">No syncs yet</div>\`;
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
              <div class="subvalue" style="color: #28a745;">\${data.scheduler.successCount || 0} success</div>
              <div class="subvalue" style="color: #dc3545;">\${data.scheduler.failureCount || 0} failed</div>
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

    async function syncAll(e) {
      const btn = e.target;
      btn.disabled = true;
      btn.innerHTML = 'Syncing... <span class="loading"></span>';
      try {
        const propertyParam = currentProperty ? \`?property=\${currentProperty}\` : '';
        const res = await fetch(\`/admin/sync/all\${propertyParam}\`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showMessage(\`Sync completed in \${data.duration}ms\`, 'success');
          loadHealth();
        } else {
          showMessage('Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync All (Listing + Availability)';
      }
    }

    async function syncListing(e) {
      const btn = e.target;
      btn.disabled = true;
      btn.innerHTML = 'Syncing... <span class="loading"></span>';
      try {
        const propertyParam = currentProperty ? \`?property=\${currentProperty}\` : '';
        const res = await fetch(\`/admin/sync/listing\${propertyParam}\`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showMessage('Listing synced', 'success');
          loadHealth();
        } else {
          showMessage('Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Listing Only';
      }
    }

    async function syncAvailability(e) {
      const btn = e.target;
      btn.disabled = true;
      btn.innerHTML = 'Syncing... <span class="loading"></span>';
      try {
        const propertyParam = currentProperty ? \`?property=\${currentProperty}\` : '';
        const res = await fetch(\`/admin/sync/availability\${propertyParam}\`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showMessage(\`Availability synced (\${data.daysCount || 0} days)\`, 'success');
          loadHealth();
        } else {
          showMessage('Sync failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        showMessage('Sync failed: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Availability Only';
      }
    }

    async function viewTable(tableName) {
      const tableView = document.getElementById('tableView');
      tableView.innerHTML = '<p style="margin-top: 15px;">Loading...</p>';
      try {
        const res = await fetch(\`/admin/db/\${tableName}\`);
        const data = await res.json();
        if (data.rows.length === 0) {
          tableView.innerHTML = '<p style="margin-top: 15px; color: #888;">No data found.</p>';
          return;
        }
        const columns = Object.keys(data.rows[0]);
        tableView.innerHTML = \`
          <h3 style="margin-top: 20px; color: #555;">\${tableName} (\${data.count} rows)</h3>
          <div style="overflow-x: auto;">
            <table>
              <thead><tr>\${columns.map(col => \`<th>\${col}</th>\`).join('')}</tr></thead>
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
      } catch (error) {
        tableView.innerHTML = \`<p style="margin-top: 15px; color: #dc3545;">Failed to load table: \${error.message}</p>\`;
      }
    }

    // Init
    loadProperties();
    loadHealth();
    setInterval(loadHealth, 10000);
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
 * Query params: property=slug (optional, syncs specific property or all if not specified)
 */
router.post('/sync/all', async (req, res, next) => {
  try {
    const propertySlug = req.query.property as string | undefined;

    if (propertySlug) {
      const property = getPropertyBySlug(propertySlug);
      if (!property) {
        return res.status(404).json({ error: `Property '${propertySlug}' not found` });
      }
      logger.info({ propertySlug }, 'Manual full sync triggered for property via admin');
      const result = await runETLJobForProperty(property, true);
      return res.json({
        success: result.success,
        propertySlug: property.slug,
        listing: result.listing,
        availability: result.availability,
        duration: result.duration,
        timestamp: result.timestamp,
      });
    }

    // Sync all properties
    logger.info('Manual full sync triggered via admin');
    const result = await runETLJob(true); // force=true

    res.json({
      success: result.success,
      listing: result.listing,
      availability: result.availability,
      duration: result.duration,
      timestamp: result.timestamp,
    });
    return;
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /admin/sync/listing
 * Trigger listing sync only
 * Query params: property=slug (optional)
 */
router.post('/sync/listing', async (req, res, next) => {
  try {
    const propertySlug = req.query.property as string | undefined;
    let listingId: string;

    if (propertySlug) {
      const property = getPropertyBySlug(propertySlug);
      if (!property) {
        return res.status(404).json({ error: `Property '${propertySlug}' not found` });
      }
      listingId = property.guestyPropertyId;
      logger.info({ propertySlug }, 'Manual listing sync triggered for property via admin');
    } else {
      const defaultProperty = getDefaultProperty();
      listingId = defaultProperty?.guestyPropertyId || config.guestyPropertyId || '';
      logger.info('Manual listing sync triggered via admin');
    }

    const result = await syncListing(listingId, true); // force=true

    res.json({
      success: result.success,
      listingId: result.listingId,
      title: result.title,
      skipped: result.skipped,
      error: result.error,
    });
    return;
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /admin/sync/availability
 * Trigger availability sync only
 * Query params: property=slug (optional)
 */
router.post('/sync/availability', async (req, res, next) => {
  try {
    const propertySlug = req.query.property as string | undefined;
    let listingId: string;

    if (propertySlug) {
      const property = getPropertyBySlug(propertySlug);
      if (!property) {
        return res.status(404).json({ error: `Property '${propertySlug}' not found` });
      }
      listingId = property.guestyPropertyId;
      logger.info({ propertySlug }, 'Manual availability sync triggered for property via admin');
    } else {
      const defaultProperty = getDefaultProperty();
      listingId = defaultProperty?.guestyPropertyId || config.guestyPropertyId || '';
      logger.info('Manual availability sync triggered via admin');
    }

    const result = await syncAvailability(listingId, true); // force=true

    res.json({
      success: result.success,
      listingId: result.listingId,
      daysCount: result.daysCount,
      skipped: result.skipped,
      error: result.error,
    });
    return;
  } catch (error) {
    return next(error);
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
 * Query params: property=slug (default: first property), period=past|future (default: future)
 */
router.get('/dashboard-data', async (req, res, next) => {
  try {
    // Resolve property from query param or use default
    const propertySlug = req.query.property as string | undefined;
    let propertyId: string;

    if (propertySlug) {
      const property = getPropertyBySlug(propertySlug);
      if (!property) {
        return res.status(404).json({ error: `Property '${propertySlug}' not found` });
      }
      propertyId = property.guestyPropertyId;
    } else {
      const defaultProperty = getDefaultProperty();
      propertyId = defaultProperty?.guestyPropertyId || config.guestyPropertyId || '';
    }

    const period = (req.query.period as 'past' | 'future') || 'future';

    // Get listing info
    const listing = getListingById(propertyId);

    // Get stats from availability
    const stats = getDashboardStats(propertyId, 365, period);

    // Get conversion rate data
    const conversionData = getAllTimeConversionRate(propertyId);

    // Get detailed reservations
    const reservations = getReservationsByPeriod(propertyId, 365, period);

    // Transform reservations for frontend (include existing document numbers)
    const bookings = reservations.map(r => {
      const quote = getDocumentByReservation(r.reservation_id, 'quote');
      const invoice = getDocumentByReservation(r.reservation_id, 'invoice');

      return {
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
        quoteNumber: quote?.documentNumber || null,
        invoiceNumber: invoice?.documentNumber || null,
      };
    });

    // Get the resolved property slug for the response
    const resolvedProperty = propertySlug
      ? getPropertyBySlug(propertySlug)
      : getDefaultProperty();

    res.json({
      property: {
        slug: resolvedProperty?.slug || 'default',
        name: resolvedProperty?.name || listing?.nickname || listing?.title || 'Unknown Property',
      },
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
    return;
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /admin/properties
 * Get list of configured properties for property selector
 */
router.get('/properties', (_req, res) => {
  const properties = getAllProperties();
  const defaultProperty = getDefaultProperty();

  res.json({
    properties: properties.map(p => ({
      slug: p.slug,
      name: p.name,
      isDefault: p.slug === defaultProperty?.slug,
      ga4Enabled: p.ga4?.enabled || false,
    })),
    defaultSlug: defaultProperty?.slug || null,
  });
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;0,9..144,700;1,9..144,300&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">

  <style>
    :root {
      --color-cream: #faf8f5;
      --color-sand: #f4f1ed;
      --color-stone: #e8e4df;
      --color-charcoal: #2a2a2a;
      --color-warm-gray: #6b6560;
      --color-forest: #2d5a3d;
      --color-forest-light: #3d7a52;
      --color-terracotta: #c75b3c;
      --color-terracotta-light: #d67456;
      --color-amber: #d4a574;
      --color-sage: #8a9a7b;
      --color-red: #c44536;
      --color-red-dark: #a13828;

      --font-display: 'Fraunces', serif;
      --font-body: 'Manrope', sans-serif;

      --shadow-sm: 0 2px 8px rgba(42, 42, 42, 0.04);
      --shadow-md: 0 4px 16px rgba(42, 42, 42, 0.08);
      --shadow-lg: 0 8px 32px rgba(42, 42, 42, 0.12);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-body);
      background: var(--color-cream);
      padding: clamp(20px, 4vw, 48px);
      line-height: 1.65;
      color: var(--color-charcoal);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    h1 {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: clamp(32px, 5vw, 48px);
      line-height: 1.1;
      color: var(--color-charcoal);
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 48px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--color-stone);
    }

    .section {
      background: white;
      padding: clamp(24px, 4vw, 40px);
      margin-bottom: 32px;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      border: 1px solid var(--color-stone);
      transition: box-shadow 0.3s ease;
    }

    button {
      font-family: var(--font-body);
      background: var(--color-forest);
      color: white;
      border: none;
      padding: 14px 28px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      margin-right: 12px;
      margin-bottom: 12px;
      letter-spacing: 0.01em;
      position: relative;
      overflow: hidden;
    }

    button::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 100%);
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    button:hover::before {
      opacity: 1;
    }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(45, 90, 61, 0.3);
    }

    button.success {
      background: var(--color-forest);
    }

    button.danger {
      background: var(--color-red);
    }

    button.danger:hover {
      background: var(--color-red-dark);
      box-shadow: 0 4px 12px rgba(196, 69, 54, 0.3);
    }

    button.secondary {
      background: var(--color-warm-gray);
    }

    button.secondary:hover {
      background: var(--color-charcoal);
      box-shadow: 0 4px 12px rgba(42, 42, 42, 0.2);
    }

    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin-top: 20px;
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    th, td {
      padding: 16px 18px;
      text-align: left;
      border-bottom: 1px solid var(--color-stone);
    }

    th {
      background: linear-gradient(180deg, var(--color-sand), var(--color-cream));
      font-weight: 700;
      font-size: 13px;
      color: var(--color-charcoal);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 2px solid var(--color-stone);
    }

    td {
      font-size: 15px;
      background: white;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr {
      transition: background-color 0.2s ease, transform 0.2s ease;
    }

    tbody tr:hover {
      background: var(--color-cream) !important;
      transform: scale(1.005);
    }

    tbody tr:hover td {
      background: transparent;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .badge.active {
      background: rgba(45, 90, 61, 0.1);
      color: var(--color-forest);
    }

    .badge.inactive {
      background: rgba(196, 69, 54, 0.1);
      color: var(--color-red);
    }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(42, 42, 42, 0.6);
      backdrop-filter: blur(4px);
      justify-content: center;
      align-items: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal.show {
      display: flex;
    }

    .modal-content {
      background: white;
      padding: 40px;
      border-radius: var(--radius-lg);
      max-width: 540px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: var(--shadow-lg);
      animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .modal-header {
      margin-bottom: 32px;
    }

    .modal-header h2 {
      font-family: var(--font-display);
      color: var(--color-charcoal);
      font-size: 32px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .form-group {
      margin-bottom: 24px;
    }

    label {
      display: block;
      color: var(--color-charcoal);
      font-weight: 600;
      margin-bottom: 10px;
      font-size: 14px;
    }

    input, select {
      font-family: var(--font-body);
      width: 100%;
      padding: 12px 16px;
      border: 2px solid var(--color-stone);
      border-radius: var(--radius-sm);
      font-size: 15px;
      transition: all 0.2s ease;
      background: white;
    }

    input:focus, select:focus {
      outline: none;
      border-color: var(--color-forest);
      box-shadow: 0 0 0 3px rgba(45, 90, 61, 0.1);
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .checkbox-group input[type="checkbox"] {
      width: 20px;
      height: 20px;
      cursor: pointer;
      accent-color: var(--color-forest);
    }

    .message {
      padding: 16px 20px;
      border-radius: var(--radius-md);
      margin: 20px 0;
      display: none;
      font-weight: 500;
      border-left: 4px solid;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message.success {
      background: rgba(45, 90, 61, 0.08);
      color: var(--color-forest);
      border-left-color: var(--color-forest);
    }

    .message.error {
      background: rgba(196, 69, 54, 0.08);
      color: var(--color-red);
      border-left-color: var(--color-red);
    }

    .message.show {
      display: block;
    }

    .back-link {
      color: var(--color-forest);
      text-decoration: none;
      font-size: 15px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      transition: color 0.2s ease;
    }

    .back-link:hover {
      color: var(--color-forest-light);
    }

    .actions-cell {
      white-space: nowrap;
    }

    .actions-cell button {
      padding: 8px 16px;
      font-size: 13px;
      margin-right: 6px;
      margin-bottom: 0;
    }

    @media (max-width: 768px) {
      body {
        padding: 16px;
      }

      .header {
        flex-direction: column;
        align-items: flex-start;
        gap: 20px;
      }

      table {
        font-size: 13px;
      }

      th, td {
        padding: 12px;
      }
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

    // Load data immediately (script is at end of body, DOM is ready)
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
 * GET /admin/analytics-trend-data
 * Get daily analytics data for trend charts
 */
router.get('/analytics-trend-data', (req, res, next) => {
  try {
    const enabled = ga4Client.isEnabled();

    if (!enabled) {
      return res.json({
        enabled: false,
        data: [],
      });
    }

    const days = parseInt(req.query.days as string) || 30;
    const dailyData = getDailyAnalytics(days);

    // Transform and sort by date ascending for charts
    const trendData = dailyData
      .map(record => ({
        date: record.date,
        pageviews: record.pageviews,
        users: record.users,
        sessions: record.sessions,
        avgSessionDuration: record.avg_session_duration,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      enabled: true,
      days,
      data: trendData,
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

/**
 * GET /admin/api/document-sequence
 * Get document sequence information (last number, last invoice/quote)
 */
router.get('/api/document-sequence', (_req, res, next) => {
  try {
    const currentYear = new Date().getFullYear();
    const sequenceInfo = getDocumentSequenceInfo(currentYear);

    res.json({
      success: true,
      data: {
        year: sequenceInfo.year,
        lastNumber: sequenceInfo.lastNumber,
        nextNumber: sequenceInfo.nextNumber,
        lastInvoice: sequenceInfo.lastInvoice ? {
          documentNumber: sequenceInfo.lastInvoice.documentNumber,
          reservationId: sequenceInfo.lastInvoice.reservationId,
          customerName: sequenceInfo.lastInvoice.customer.name,
          customerCompany: sequenceInfo.lastInvoice.customer.company,
          checkIn: sequenceInfo.lastInvoice.checkIn,
          total: sequenceInfo.lastInvoice.total / 100,
          createdAt: sequenceInfo.lastInvoice.createdAt,
        } : null,
        lastQuote: sequenceInfo.lastQuote ? {
          documentNumber: sequenceInfo.lastQuote.documentNumber,
          reservationId: sequenceInfo.lastQuote.reservationId,
          customerName: sequenceInfo.lastQuote.customer.name,
          customerCompany: sequenceInfo.lastQuote.customer.company,
          checkIn: sequenceInfo.lastQuote.checkIn,
          total: sequenceInfo.lastQuote.total / 100,
          createdAt: sequenceInfo.lastQuote.createdAt,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /admin/api/document-sequence
 * Update document sequence number (for manual correction)
 */
router.post('/api/document-sequence', express.json(), (req, res, next) => {
  try {
    const { year, lastNumber } = req.body;

    if (!year || typeof lastNumber !== 'number') {
      res.status(400).json({
        success: false,
        error: 'year and lastNumber are required',
      });
      return;
    }

    // Validate year
    if (year < 2020 || year > 2100) {
      res.status(400).json({
        success: false,
        error: 'Invalid year',
      });
      return;
    }

    // Validate lastNumber
    if (lastNumber < 0 || lastNumber > 99999) {
      res.status(400).json({
        success: false,
        error: 'lastNumber must be between 0 and 99999',
      });
      return;
    }

    setDocumentSequenceNumber(year, lastNumber);

    logger.info({ year, lastNumber }, 'Document sequence manually updated via admin panel');

    res.json({
      success: true,
      message: `Next document will be: A-${year}-${String(lastNumber + 1).padStart(4, '0')} / ${year}-${String(lastNumber + 1).padStart(4, '0')}`,
      data: {
        year,
        lastNumber,
        nextNumber: lastNumber + 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
