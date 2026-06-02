/**
 * Manual one-shot send of the portfolio BI report.
 * Respects DEV_EMAIL_OVERRIDE (outside production all mail is redirected).
 *
 * Usage: npx tsx src/scripts/test-bi-email.ts
 */
import { sendBiReportEmail } from '../jobs/bi-email.js';
import logger from '../utils/logger.js';

async function main() {
  logger.info('📊 Sending test portfolio BI report...');
  const result = await sendBiReportEmail();
  if (result.sent) {
    logger.info('✅ BI report sent');
  } else {
    logger.warn({ error: result.error }, '⚠️  BI report not sent (check biReport config / recipients)');
  }
  process.exit(result.sent ? 0 : 1);
}

main().catch((error) => {
  logger.error({ error }, '❌ test-bi-email failed');
  process.exit(1);
});
