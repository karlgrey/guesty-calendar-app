/**
 * Test Email Script
 *
 * Sends a test weekly summary email immediately
 */

import { sendWeeklySummaryEmail } from '../jobs/weekly-email.js';
import { verifyEmailConnection } from '../services/email-service.js';
import logger from '../utils/logger.js';

async function main() {
  console.log('Testing Email Functionality');
  console.log('===========================\n');

  // First verify SMTP connection
  console.log('Step 1: Verifying SMTP connection...');
  const connectionOk = await verifyEmailConnection();

  if (!connectionOk) {
    console.error('❌ SMTP connection failed. Please check your email settings.');
    process.exit(1);
  }

  console.log('✅ SMTP connection verified\n');

  // Send test email
  console.log('Step 2: Sending weekly summary email...');
  const result = await sendWeeklySummaryEmail();

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
