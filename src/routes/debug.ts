/**
 * Debug Routes
 *
 * Provides human-readable views of all Guesty API data
 */

import { Router } from 'express';
import { guestyClient } from '../services/guesty-client.js';
import { config } from '../config/index.js';
import { getDatabase } from '../db/index.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /debug/raw-listing
 * Return raw listing JSON from Guesty API
 */
router.get('/raw-listing', async (_req, res) => {
  try {
    logger.info('Fetching raw listing from Guesty API');
    const listing = await guestyClient.getListing(config.guestyPropertyId);
    res.json(listing);
  } catch (error) {
    logger.error({ error }, 'Error fetching raw listing');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /debug
 * Display all Guesty API data in human-readable format
 */
router.get('/', async (_req, res) => {
  try {
    const propertyId = config.guestyPropertyId;

    // Get data from database cache only (to avoid rate limiting)
    logger.info('Fetching debug data from cache');

    const db = getDatabase();
    const cachedListing = db.prepare('SELECT * FROM listings WHERE id = ?').get(propertyId);
    const cachedAvailability = db.prepare('SELECT * FROM availability WHERE listing_id = ? LIMIT 100').all(propertyId);
    const cachedQuotes = db.prepare('SELECT * FROM quotes_cache ORDER BY created_at DESC LIMIT 20').all();

    // Parse the cached listing data
    if (!cachedListing) {
      throw new Error('No cached listing found. Please run sync first: POST /sync/all');
    }

    const listingData = cachedListing as any;
    // Parse JSON fields
    if (listingData.taxes && typeof listingData.taxes === 'string') {
      listingData.taxes = JSON.parse(listingData.taxes);
    }

    const calendarData = cachedAvailability.map((day: any) => ({
      date: day.date,
      status: day.status,
      price: day.price,
      currency: listingData.currency,
      minNights: day.min_nights,
      available: day.status === 'available',
      isBlocked: day.status !== 'available',
    }));

    // Build HTML response
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guesty API Debug Data</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 2rem;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    h1 {
      color: #2563eb;
      margin-bottom: 0.5rem;
      font-size: 2rem;
    }

    .subtitle {
      color: #6b7280;
      margin-bottom: 2rem;
      font-size: 0.875rem;
    }

    .section {
      margin-bottom: 3rem;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }

    .section-header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .section-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .section-badge {
      background: rgba(255,255,255,0.2);
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .section-content {
      padding: 1.5rem;
      background: #fafafa;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .field {
      background: white;
      padding: 1rem;
      border-radius: 6px;
      border: 1px solid #e5e7eb;
    }

    .field-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .field-value {
      font-size: 1rem;
      color: #111827;
      word-break: break-word;
    }

    .field-value.highlight {
      color: #2563eb;
      font-weight: 600;
      font-size: 1.25rem;
    }

    .field-value.success {
      color: #059669;
      font-weight: 600;
    }

    .field-value.warning {
      color: #d97706;
      font-weight: 600;
    }

    .field-value.error {
      color: #dc2626;
      font-weight: 600;
    }

    pre {
      background: #1f2937;
      color: #f3f4f6;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .json-key {
      color: #60a5fa;
    }

    .json-string {
      color: #34d399;
    }

    .json-number {
      color: #fbbf24;
    }

    .json-boolean {
      color: #f472b6;
    }

    .json-null {
      color: #9ca3af;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 6px;
      overflow: hidden;
    }

    thead {
      background: #f9fafb;
    }

    th {
      padding: 0.75rem 1rem;
      text-align: left;
      font-size: 0.75rem;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 2px solid #e5e7eb;
    }

    td {
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      border-bottom: 1px solid #e5e7eb;
    }

    tbody tr:hover {
      background: #f9fafb;
    }

    .status-available {
      color: #059669;
      font-weight: 600;
    }

    .status-booked {
      color: #dc2626;
      font-weight: 600;
    }

    .status-blocked {
      color: #6b7280;
      font-weight: 600;
    }

    .collapsible {
      cursor: pointer;
      user-select: none;
    }

    .collapsible::before {
      content: '▼ ';
      display: inline-block;
      transition: transform 0.2s;
    }

    .collapsible.collapsed::before {
      transform: rotate(-90deg);
    }

    .collapsible-content {
      max-height: 500px;
      overflow: auto;
      transition: max-height 0.3s ease-out;
    }

    .collapsible-content.collapsed {
      max-height: 0;
      overflow: hidden;
    }

    .endpoint-badge {
      display: inline-block;
      background: #dbeafe;
      color: #1e40af;
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 Guesty API Debug Data</h1>
    <p class="subtitle">Real-time data from Guesty Open API endpoints and local cache</p>

    <!-- Listing Data -->
    <div class="section">
      <div class="section-header">
        <h2>📋 Listing Information</h2>
        <span class="section-badge">GET /listings/{id}</span>
      </div>
      <div class="section-content">
        <div class="endpoint-badge">GET /api/v1/listings/${propertyId}</div>

        <div class="grid">
          <div class="field">
            <div class="field-label">Property ID</div>
            <div class="field-value">${listingData._id}</div>
          </div>
          <div class="field">
            <div class="field-label">Title</div>
            <div class="field-value highlight">${listingData.title}</div>
          </div>
          <div class="field">
            <div class="field-label">Nickname</div>
            <div class="field-value">${listingData.nickname || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Property Type</div>
            <div class="field-value">${listingData.propertyType || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Room Type</div>
            <div class="field-value">${listingData.roomType || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Accommodates</div>
            <div class="field-value highlight">${listingData.accommodates} guests</div>
          </div>
          <div class="field">
            <div class="field-label">Bedrooms</div>
            <div class="field-value">${listingData.bedrooms || 0}</div>
          </div>
          <div class="field">
            <div class="field-label">Beds</div>
            <div class="field-value">${listingData.beds || 0}</div>
          </div>
          <div class="field">
            <div class="field-label">Bathrooms</div>
            <div class="field-value">${listingData.bathrooms || 0}</div>
          </div>
          <div class="field">
            <div class="field-label">Currency</div>
            <div class="field-value">${listingData.prices?.currency || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Base Price</div>
            <div class="field-value highlight">${listingData.prices?.basePrice || 'N/A'} ${listingData.prices?.currency || ''}</div>
          </div>
          <div class="field">
            <div class="field-label">Cleaning Fee</div>
            <div class="field-value">${listingData.prices?.cleaningFee || 0} ${listingData.prices?.currency || ''}</div>
          </div>
          <div class="field">
            <div class="field-label">Extra Person Fee</div>
            <div class="field-value">${listingData.prices?.extraPersonFee || 0} ${listingData.prices?.currency || ''}</div>
          </div>
          <div class="field">
            <div class="field-label">Guests Included</div>
            <div class="field-value">${listingData.prices?.guestsIncludedInRegularFee || 1}</div>
          </div>
          <div class="field">
            <div class="field-label">Weekly Discount</div>
            <div class="field-value ${listingData.prices?.weeklyPriceFactor ? 'success' : ''}">${listingData.prices?.weeklyPriceFactor ? Math.round((1 - listingData.prices.weeklyPriceFactor) * 100) + '%' : 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Monthly Discount</div>
            <div class="field-value ${listingData.prices?.monthlyPriceFactor ? 'success' : ''}">${listingData.prices?.monthlyPriceFactor ? Math.round((1 - listingData.prices.monthlyPriceFactor) * 100) + '%' : 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Min Nights</div>
            <div class="field-value">${listingData.terms?.minNights || 1}</div>
          </div>
          <div class="field">
            <div class="field-label">Max Nights</div>
            <div class="field-value">${listingData.terms?.maxNights || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Address</div>
            <div class="field-value">${listingData.address?.full || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">City</div>
            <div class="field-value">${listingData.address?.city || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Country</div>
            <div class="field-value">${listingData.address?.country || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label">Active</div>
            <div class="field-value ${listingData.active ? 'success' : 'error'}">${listingData.active ? 'Yes' : 'No'}</div>
          </div>
          <div class="field">
            <div class="field-label">Published</div>
            <div class="field-value ${listingData.publicDescription?.summary ? 'success' : 'warning'}">${listingData.publicDescription?.summary ? 'Yes' : 'No'}</div>
          </div>
        </div>

        <div class="field">
          <div class="field-label collapsible" onclick="toggleCollapse(this)">Full Raw JSON Response</div>
          <div class="field-value collapsible-content collapsed">
            <pre>${syntaxHighlightJSON(listingData)}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Calendar/Availability Data -->
    <div class="section">
      <div class="section-header">
        <h2>📅 Calendar & Availability (12 months)</h2>
        <span class="section-badge">${calendarData.length} days</span>
      </div>
      <div class="section-content">
        <div class="endpoint-badge">GET /availability-pricing/api/calendar/listings/{id}?startDate=...&endDate=...</div>

        <p style="margin-bottom: 1rem; color: #6b7280;">
          Showing first 30 days. Total days fetched: <strong>${calendarData.length}</strong>
        </p>

        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Price</th>
                <th>Currency</th>
                <th>Min Nights</th>
                <th>Available</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              ${calendarData.slice(0, 30).map((day: any) => `
                <tr>
                  <td>${day.date}</td>
                  <td class="status-${day.status}">${day.status}</td>
                  <td>${day.price || 'N/A'}</td>
                  <td>${day.currency || 'N/A'}</td>
                  <td>${day.minNights || 1}</td>
                  <td>${day.available ? '✓' : '✗'}</td>
                  <td>${day.isBlocked ? '✓' : '✗'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="field" style="margin-top: 1.5rem;">
          <div class="field-label collapsible" onclick="toggleCollapse(this)">Full Calendar Raw JSON Response (all ${calendarData.length} days)</div>
          <div class="field-value collapsible-content collapsed">
            <pre>${syntaxHighlightJSON(calendarData)}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Cached Database Data -->
    <div class="section">
      <div class="section-header">
        <h2>💾 Cached Database Data</h2>
        <span class="section-badge">Local SQLite</span>
      </div>
      <div class="section-content">
        <h3 style="margin-bottom: 1rem; color: #374151;">Cached Listing</h3>
        ${cachedListing ? `
          <div class="field">
            <div class="field-label">Last Synced</div>
            <div class="field-value">${(cachedListing as any).last_synced_at || 'N/A'}</div>
          </div>
          <div class="field">
            <div class="field-label collapsible" onclick="toggleCollapse(this)">Cached Listing Data</div>
            <div class="field-value collapsible-content collapsed">
              <pre>${syntaxHighlightJSON(cachedListing)}</pre>
            </div>
          </div>
        ` : `
          <p style="color: #6b7280;">No cached listing data found</p>
        `}

        <h3 style="margin: 2rem 0 1rem; color: #374151;">Cached Availability (last 100 days)</h3>
        ${cachedAvailability.length > 0 ? `
          <p style="margin-bottom: 1rem; color: #6b7280;">Total cached days: <strong>${cachedAvailability.length}</strong></p>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Price</th>
                  <th>Min Nights</th>
                  <th>Cached At</th>
                </tr>
              </thead>
              <tbody>
                ${cachedAvailability.slice(0, 20).map((day: any) => `
                  <tr>
                    <td>${day.date}</td>
                    <td class="status-${day.status}">${day.status}</td>
                    <td>${day.price || 'N/A'}</td>
                    <td>${day.min_nights || 1}</td>
                    <td>${day.updated_at}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p style="color: #6b7280;">No cached availability data found</p>
        `}

        <h3 style="margin: 2rem 0 1rem; color: #374151;">Cached Quotes (last 20)</h3>
        ${cachedQuotes.length > 0 ? `
          <p style="margin-bottom: 1rem; color: #6b7280;">Total cached quotes: <strong>${cachedQuotes.length}</strong></p>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>Check-in</th>
                  <th>Check-out</th>
                  <th>Guests</th>
                  <th>Total Price</th>
                  <th>Created At</th>
                  <th>Expires At</th>
                </tr>
              </thead>
              <tbody>
                ${cachedQuotes.map((quote: any) => {
                  return `
                    <tr>
                      <td>${quote.check_in}</td>
                      <td>${quote.check_out}</td>
                      <td>${quote.guests}</td>
                      <td>${quote.total_price || 'N/A'} ${quote.currency || ''}</td>
                      <td>${quote.created_at}</td>
                      <td>${quote.expires_at}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p style="color: #6b7280;">No cached quotes found</p>
        `}
      </div>
    </div>

    <!-- API Endpoints Summary -->
    <div class="section">
      <div class="section-header">
        <h2>🔗 Guesty API Endpoints Used</h2>
        <span class="section-badge">Reference</span>
      </div>
      <div class="section-content">
        <div class="field">
          <div class="field-label">OAuth Token</div>
          <div class="field-value">
            <code style="background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 4px;">POST ${config.guestyOAuthUrl}</code>
            <p style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">Exchange client credentials for access token (24h validity)</p>
          </div>
        </div>

        <div class="field">
          <div class="field-label">Get Listing</div>
          <div class="field-value">
            <code style="background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 4px;">GET ${config.guestyApiUrl}/listings/{listingId}</code>
            <p style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">Fetch property details including pricing, amenities, and terms</p>
          </div>
        </div>

        <div class="field">
          <div class="field-label">Get Calendar</div>
          <div class="field-value">
            <code style="background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 4px;">GET ${config.guestyApiUrl}/availability-pricing/api/calendar/listings/{listingId}</code>
            <p style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">Fetch availability, pricing, and minimum stay requirements for date range</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    function toggleCollapse(element) {
      element.classList.toggle('collapsed');
      const content = element.nextElementSibling;
      content.classList.toggle('collapsed');
    }
  </script>
</body>
</html>
    `;

    res.send(html);
  } catch (error) {
    logger.error({ error }, 'Error fetching debug data');
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; padding: 2rem;">
          <h1 style="color: #dc2626;">Error</h1>
          <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
        </body>
      </html>
    `);
  }
});

/**
 * Syntax highlight JSON
 */
function syntaxHighlightJSON(obj: any): string {
  let json = JSON.stringify(obj, null, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}

export default router;
