/**
 * Manueller One-Shot-Versand der neuen Reports (#1223). Respektiert DEV_EMAIL_OVERRIDE
 * (außerhalb von production wird alle Mail umgeleitet). Empfänger kommen aus der DB.
 *
 * Usage: npx tsx src/scripts/test-report-emails.ts monthly | calendar
 */
import { initDatabase, runMigrations } from '../db/index.js';
import { sendPortfolioMonthlyEmail } from '../jobs/bi-email.js';
import { sendCalendarWeeklyEmail } from '../jobs/calendar-email.js';
import logger from '../utils/logger.js';

async function main() {
  const which = process.argv[2];
  if (which !== 'monthly' && which !== 'calendar') {
    logger.error("Usage: npx tsx src/scripts/test-report-emails.ts monthly | calendar");
    process.exit(2);
  }
  initDatabase();
  runMigrations();
  const result = which === 'monthly' ? await sendPortfolioMonthlyEmail() : await sendCalendarWeeklyEmail();
  if (result.sent) logger.info({ report: which }, '✅ Report gesendet');
  else logger.warn({ report: which, error: result.error }, '⚠️  Report nicht gesendet (Empfänger/Konfiguration prüfen)');
  process.exit(result.sent ? 0 : 1);
}

main().catch((error) => {
  logger.error({ error }, '❌ test-report-emails failed');
  process.exit(1);
});
