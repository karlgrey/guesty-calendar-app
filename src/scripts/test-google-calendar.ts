/**
 * Test Google Calendar Script
 *
 * Tests the Google Calendar API connection and syncs reservations.
 * Usage: npx tsx src/scripts/test-google-calendar.ts <slug>
 */

import { googleCalendarClient } from '../services/google-calendar-client.js';
import { syncGoogleCalendarForProperty } from '../jobs/sync-google-calendar.js';
import { getPropertyBySlug, getAllProperties } from '../config/properties.js';
import { initDatabase } from '../db/index.js';
import logger from '../utils/logger.js';

async function main() {
  const slug = process.argv[2];

  console.log('Google Calendar Sync Test');
  console.log('========================');

  if (!slug) {
    console.log('Usage: npx tsx src/scripts/test-google-calendar.ts <slug>');
    console.log('Available properties:', getAllProperties().map(p => p.slug).join(', '));
    process.exit(1);
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  console.log(`Property: ${property.name} (${property.slug})`);

  if (!property.googleCalendar?.enabled) {
    console.error(`Google Calendar is not enabled for '${slug}'`);
    console.log('Add googleCalendar config to data/properties.json:');
    console.log(JSON.stringify({ googleCalendar: { enabled: true, calendarId: 'your-calendar-id@group.calendar.google.com' } }, null, 2));
    process.exit(1);
  }

  const calendarId = property.googleCalendar.calendarId;
  if (!calendarId) {
    console.error('calendarId is not set in googleCalendar config');
    process.exit(1);
  }

  console.log(`Calendar ID: ${calendarId}\n`);

  // Initialize database
  console.log('Step 1: Initializing database...');
  try {
    initDatabase();
    console.log('  Database initialized\n');
  } catch (error) {
    console.error('  Database initialization failed:', error);
    process.exit(1);
  }

  // Test connection
  console.log('Step 2: Testing Google Calendar API connection...');
  const connResult = await googleCalendarClient.testConnection(calendarId);

  if (!connResult.success) {
    console.error(`  Connection failed: ${connResult.error}`);
    console.log('\nMake sure:');
    console.log('  1. data/ga4-service-account.json exists');
    console.log('  2. Service account has "Make changes to events" access to the calendar');
    console.log('  3. Calendar ID is correct');
    process.exit(1);
  }

  console.log('  Connection successful\n');

  // Sync reservations
  console.log('Step 3: Syncing reservations to Google Calendar...');
  const result = await syncGoogleCalendarForProperty(property);

  if (result.success) {
    console.log(`\n  Sync completed in ${result.durationMs}ms`);
    console.log(`  Events upserted: ${result.eventsUpserted}`);
    console.log(`  Events deleted: ${result.eventsDeleted}`);
  } else {
    console.error(`\n  Sync failed: ${result.error}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  logger.error({ error }, 'Google Calendar test script failed');
  console.error('\nScript failed:', error);
  process.exit(1);
});
