/**
 * Setup Google Calendar Script
 *
 * Creates a new Google Calendar owned by the service account,
 * then shares it with specified email addresses.
 *
 * Usage: npx tsx src/scripts/setup-google-calendar.ts <slug> <email1> [email2] ...
 */

import { google } from 'googleapis';
import { GoogleAuth } from 'googleapis-common';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPropertyBySlug, getAllProperties } from '../config/properties.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_FILE = path.resolve(__dirname, '../../data/ga4-service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main() {
  const slug = process.argv[2];
  const emails = process.argv.slice(3);

  console.log('Google Calendar Setup');
  console.log('=====================\n');

  if (!slug || emails.length === 0) {
    console.log('Usage: npx tsx src/scripts/setup-google-calendar.ts <slug> <email1> [email2] ...');
    console.log('');
    console.log('This creates a new Google Calendar owned by the service account');
    console.log('and shares it with the specified email addresses.\n');
    console.log('Available properties:', getAllProperties().map(p => p.slug).join(', '));
    process.exit(1);
  }

  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  console.log(`Property: ${property.name}`);
  console.log(`Owners:   ${emails.join(', ')}\n`);

  // Init API
  const auth = new GoogleAuth({ keyFile: KEY_FILE, scopes: SCOPES });
  const calendar = google.calendar({ version: 'v3', auth });

  // Create calendar
  console.log('Creating calendar...');
  const res = await calendar.calendars.insert({
    requestBody: {
      summary: `${property.name} - Bookings`,
      description: `Reservations for ${property.name} (managed by Guesty Calendar App)`,
      timeZone: property.timezone,
    },
  });

  const calendarId = res.data.id!;
  console.log(`  Calendar created: ${calendarId}\n`);

  // Share with each email
  for (const email of emails) {
    console.log(`Sharing with ${email}...`);
    try {
      await calendar.acl.insert({
        calendarId,
        requestBody: {
          role: 'owner',
          scope: { type: 'user', value: email },
        },
      });
      console.log(`  Shared (owner)`);
    } catch (error: any) {
      console.error(`  Failed: ${error.message}`);
    }
  }

  console.log('\n========================================');
  console.log('Done! Update data/properties.json:\n');
  console.log(JSON.stringify({ googleCalendar: { enabled: true, calendarId } }, null, 2));
  console.log('\nThen test: npx tsx src/scripts/test-google-calendar.ts ' + slug);
}

main().catch((error) => {
  console.error('\nScript failed:', error.message);
  process.exit(1);
});
