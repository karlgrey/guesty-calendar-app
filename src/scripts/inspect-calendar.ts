import { googleCalendarClient } from '../services/google-calendar-client.js';
import { getPropertyBySlug } from '../config/properties.js';

async function main() {
  const slug = process.argv[2] || 'farmhouse';
  const property = getPropertyBySlug(slug);
  if (!property?.googleCalendar?.calendarId) {
    console.error('No calendar configured for', slug);
    process.exit(1);
  }

  const events = await googleCalendarClient.listEvents(property.googleCalendar.calendarId);
  console.log(`${events.length} events in ${property.name}:\n`);

  for (const e of events.slice(0, 3)) {
    console.log('Summary:', e.summary);
    console.log('Start:', JSON.stringify(e.start));
    console.log('End:', JSON.stringify(e.end));
    console.log('Description:', e.description);
    console.log('---');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
