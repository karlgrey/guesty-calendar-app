/**
 * One-off backfill: re-process archived Airbnb payout mails (previously
 * classified 'unknown'/ignored) and reconcile reservations against the iCal.
 *
 * Usage: npx tsx src/scripts/backfill-airbnb-payouts.ts
 */
import { getDatabase, initDatabase, runMigrations } from '../db/index.js';
import { getAllProperties } from '../config/properties.js';
import { parsePayoutMail } from '../parsers/airbnb-mail/payout.js';
import { applyPayout } from '../services/airbnb-mail/payout-applier.js';
import { reconcileAirbnbReservations } from '../jobs/airbnb-mail/reconcile-ical.js';
import { updateParseStatus } from '../repositories/airbnb-mail-archive-repository.js';

initDatabase();
runMigrations();
const db = getDatabase();

const rows = db.prepare(`
  SELECT message_id, imap_uid, subject, received_at, raw_body
  FROM airbnb_mail_archive
  WHERE subject LIKE 'Wir haben eine Auszahlung%'
  ORDER BY received_at
`).all() as Array<{ message_id: string; imap_uid: number; subject: string; received_at: string; raw_body: string }>;

console.log(`Found ${rows.length} archived payout mails`);

for (const row of rows) {
  const parsed = parsePayoutMail({
    uid: row.imap_uid, messageId: row.message_id, subject: row.subject,
    fromAddress: '', receivedAt: row.received_at,
    htmlBody: row.raw_body ?? '', textBody: '',
  });
  if (!parsed || parsed.items.length === 0) {
    console.log(`  ✗ ${row.received_at} ${row.subject} — parser returned ${parsed ? '0 items' : 'null'}`);
    continue;
  }
  const result = applyPayout(parsed);
  updateParseStatus(row.message_id, 'ok', null, result.matchedCodes[0] ?? null, 'payout');
  console.log(`  ✓ ${row.received_at} total=${parsed.totalAmount} matched=[${result.matchedCodes}] unmatched=[${result.unmatchedCodes}] dates=[${result.dateCorrections}]`);
}

for (const property of getAllProperties()) {
  if (!property.airbnbListingId || !property.airbnbIcalUrl) continue;
  const recon = reconcileAirbnbReservations(property);
  console.log(`Reconcile ${property.slug}: updated=[${recon.updated}] created=[${recon.created}] missingInIcal=[${recon.missingInIcal}]`);
}

console.log('Backfill done.');
