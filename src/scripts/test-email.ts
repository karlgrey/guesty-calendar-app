/**
 * Test Email Script
 *
 * Sends a test weekly summary email immediately
 */

import { sendWeeklySummaryEmail, sendWeeklySummaryEmailForProperty } from '../jobs/weekly-email.js';
import { getPropertyBySlug, getAllProperties } from '../config/properties.js';
import { verifyEmailConnection } from '../services/email-service.js';
import { initDatabase } from '../db/index.js';
import logger from '../utils/logger.js';

async function main() {
  const slug = process.argv[2];

  console.log('Testing Email Functionality');
  console.log('===========================');
  if (slug) {
    console.log(`Property: ${slug}`);
  } else {
    console.log('Usage: npx tsx src/scripts/test-email.ts [slug]');
    console.log('Available properties:', getAllProperties().map(p => p.slug).join(', '));
  }
  console.log('');

  // Initialize database
  console.log('Step 1: Initializing database...');
  try {
    initDatabase();
    console.log('✅ Database initialized\n');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }

  // Verify email connection
  console.log('Step 2: Verifying email connection...');
  const connectionOk = await verifyEmailConnection();

  if (!connectionOk) {
    console.error('❌ Email connection failed. Please check your email settings.');
    process.exit(1);
  }

  console.log('✅ Email connection verified\n');

  // Send test email
  let result;
  if (slug) {
    const property = getPropertyBySlug(slug);
    if (!property) {
      console.error(`❌ Property '${slug}' not found`);
      process.exit(1);
    }
    console.log(`Step 3: Sending weekly summary email for ${property.name}...`);
    result = await sendWeeklySummaryEmailForProperty(property);
  } else {
    console.log('Step 3: Sending weekly summary email (default property)...');
    result = await sendWeeklySummaryEmail();
  }

  if (result.sent) {
    console.log('\n✅ Test email sent successfully!');
    console.log(`Recipients: ${result.recipientCount}`);
  } else if (!result.success) {
    console.error('\n❌ Failed to send email');
    console.error(`Error: ${result.error}`);
    process.exit(1);
  } else {
    console.log('\n⚠️  Email not sent');
    console.log(`Reason: ${result.error || 'Unknown'}`);
  }

  process.exit(0);
}

main().catch((error) => {
  logger.error({ error }, 'Test email script failed');
  console.error('\n❌ Script failed:', error);
  process.exit(1);
});
