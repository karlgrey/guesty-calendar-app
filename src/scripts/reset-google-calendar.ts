/**
 * Reset Google Calendar - delete all events and re-sync
 *
 * Usage: npx tsx src/scripts/reset-google-calendar.ts <slug>
 */

import { googleCalendarClient } from '../services/google-calendar-client.js';
import { syncGoogleCalendarForProperty } from '../jobs/sync-google-calendar.js';
import { getPropertyBySlug, getAllProperties } from '../config/properties.js';
import { initDatabase } from '../db/index.js';

async function main() {
  const slug = process.argv[2];

  if (!slug) {
    console.log('Usage: npx tsx src/scripts/reset-google-calendar.ts <slug>');
    console.log('Available:', getAllProperties().map(p => p.slug).join(', '));
    process.exit(1);
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  const calendarId = property.googleCalendar?.calendarId;
  if (!calendarId) {
    console.error('No calendarId configured');
    process.exit(1);
  }

  initDatabase();

  // Step 1: Delete all existing events
  console.log(`Deleting all events from ${property.name} calendar...`);
  const events = await googleCalendarClient.listEvents(calendarId);
  console.log(`  Found ${events.length} events`);

  let deleted = 0;
  for (const event of events) {
    if (event.id) {
      try {
        await googleCalendarClient.deleteEvent(calendarId, event.id);
        deleted++;
      } catch (e) {
        // ignore
      }
    }
  }
  console.log(`  Deleted ${deleted} events\n`);

  // Step 2: Re-sync
  console.log('Re-syncing reservations...');
  const result = await syncGoogleCalendarForProperty(property);

  if (result.success) {
    console.log(`  Created ${result.eventsUpserted} events in ${result.durationMs}ms`);
  } else {
    console.error(`  Sync failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
