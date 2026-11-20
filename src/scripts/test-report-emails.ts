/**
 * Manueller One-Shot-Versand der neuen Reports (#1223). Respektiert DEV_EMAIL_OVERRIDE
 * (außerhalb von production wird alle Mail umgeleitet). Empfänger kommen aus der DB.
 *
 * Usage: npx tsx src/scripts/test-report-emails.ts monthly | calendar
 *   monthly  = Portfolio-Monatsreport (eine Mail)
 *   calendar = Kalender-Report "Nächste Gäste", je Objekt eine Mail an dessen Abonnenten
 *              (Exit 0, wenn mindestens eine Mail rausging, sonst 1)
 */
import { initDatabase, runMigrations } from '../db/index.js';
import { sendPortfolioMonthlyEmail } from '../jobs/bi-email.js';
import { sendCalendarWeeklyEmails } from '../jobs/calendar-email.js';
import logger from '../utils/logger.js';

async function main() {
  const which = process.argv[2];
  if (which !== 'monthly' && which !== 'calendar') {
    logger.error("Usage: npx tsx src/scripts/test-report-emails.ts monthly | calendar");
    process.exit(2);
  }
  initDatabase();
  runMigrations();
  if (which === 'calendar') {
    const results = await sendCalendarWeeklyEmails();
    for (const r of results) {
      logger.info({ report: which, propertySlug: r.propertySlug, sent: r.sent, success: r.success, recipientCount: r.recipientCount, error: r.error }, 'Kalender-Report Ergebnis je Objekt');
    }
    const sentCount = results.filter((r) => r.sent).length;
    if (sentCount > 0) logger.info({ report: which, sentCount }, '✅ Report gesendet');
    else logger.warn({ report: which }, '⚠️  Report nicht gesendet (Empfänger/Konfiguration prüfen)');
    process.exit(sentCount > 0 ? 0 : 1);
  }
  const result = await sendPortfolioMonthlyEmail();
  if (result.sent) logger.info({ report: which }, '✅ Report gesendet');
  else logger.warn({ report: which, error: result.error }, '⚠️  Report nicht gesendet (Empfänger/Konfiguration prüfen)');
  process.exit(result.sent ? 0 : 1);
}

main().catch((error) => {
  logger.error({ error }, '❌ test-report-emails failed');
  process.exit(1);
});
