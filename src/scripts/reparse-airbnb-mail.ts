/**
 * Reparse Airbnb-Mail
 *
 * Re-runs the parser pipeline on archived raw mails. Use this after fixing
 * parser bugs or calibrating patterns against live data.
 *
 * Usage:
 *   npx tsx src/scripts/reparse-airbnb-mail.ts <message_id>           # single, only if status=error
 *   npx tsx src/scripts/reparse-airbnb-mail.ts <message_id> --force   # single, even if status=ok
 *   npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors           # all error mails
 *   npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors --slug=X  # only that property
 */

import { initDatabase, getDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import {
  getMail,
  getReparseCandidates,
  updateParseStatus,
} from '../repositories/airbnb-mail-archive-repository.js';
import { detectMailType } from '../parsers/airbnb-mail/index.js';
import { parseConfirmedBooking } from '../parsers/airbnb-mail/confirmed-booking.js';
import { parseBookingInquiry } from '../parsers/airbnb-mail/booking-inquiry.js';
import { parseCancellation } from '../parsers/airbnb-mail/cancellation.js';
import { mapAirbnbReservation } from '../mappers/airbnb-mail/reservation-mapper.js';
import { upsertReservation } from '../repositories/reservation-repository.js';
import type { RawMail } from '../types/airbnb-mail.js';
import type { MailRow } from '../repositories/airbnb-mail-archive-repository.js';

function rowToRaw(row: MailRow): RawMail {
  return {
    uid: row.imap_uid,
    messageId: row.message_id,
    subject: row.subject ?? '',
    fromAddress: row.from_address ?? '',
    receivedAt: row.received_at,
    htmlBody: row.raw_body,
    textBody: row.raw_body, // archive stores combined body; parsers fall back from html→text
  };
}

async function processMail(row: MailRow): Promise<{ ok: boolean; error?: string }> {
  const property = getPropertyBySlug(row.property_slug);
  if (!property || property.provider !== 'airbnb-mail' || !property.airbnbListingId) {
    return { ok: false, error: `Property ${row.property_slug} not configured as airbnb-mail` };
  }

  const raw = rowToRaw(row);
  const type = detectMailType(raw.subject);
  if (type === 'unknown') {
    updateParseStatus(row.message_id, 'ignored', `Unrecognised Subject: ${raw.subject}`, null, type);
    return { ok: false, error: 'ignored' };
  }
  if (type === 'modification') {
    updateParseStatus(row.message_id, 'ignored', 'modification: handled by iCal reconciliation', null, type);
    return { ok: false, error: 'ignored' };
  }

  const parsed =
    type === 'confirmed' ? parseConfirmedBooking(raw) :
    type === 'inquiry' ? parseBookingInquiry(raw) :
    type === 'cancellation' ? parseCancellation(raw) :
    null;

  if (!parsed) {
    updateParseStatus(row.message_id, 'error', 'Parser returned null', null, type);
    return { ok: false, error: 'Parser returned null' };
  }

  const defaultTimes = {
    checkIn: property.googleCalendar?.checkInTime ?? '15:00',
    checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
  };
  const { asInquiry, asReservation } = mapAirbnbReservation(parsed, property.airbnbListingId, defaultTimes);

  const db = getDatabase();
  db.prepare(`
    INSERT INTO inquiries (
      inquiry_id, listing_id, status, check_in, check_out,
      guest_name, guests_count, source, created_at_guesty, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inquiry_id) DO UPDATE SET
      status = excluded.status,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      guest_name = excluded.guest_name,
      guests_count = excluded.guests_count,
      source = excluded.source,
      last_synced_at = excluded.last_synced_at
  `).run(
    asInquiry.inquiry_id, asInquiry.listing_id, asInquiry.status,
    asInquiry.check_in, asInquiry.check_out, asInquiry.guest_name,
    asInquiry.guests_count, asInquiry.source, asInquiry.created_at_guesty,
    asInquiry.last_synced_at
  );
  if (asReservation) {
    upsertReservation(asReservation);
  } else if (type === 'cancellation') {
    db.prepare(`DELETE FROM reservations WHERE reservation_id = ?`).run(parsed.reservationCode);
  }
  updateParseStatus(row.message_id, 'ok', null, parsed.reservationCode, type);
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  initDatabase();

  if (args.includes('--all-errors') || args.includes('--reclassify')) {
    const slugArg = args.find((a) => a.startsWith('--slug='));
    const slug = slugArg?.split('=')[1];
    const mails = getReparseCandidates(slug);
    console.log(`Reparsing ${mails.length} mails (status=error|ignored)…`);
    let ok = 0, ignored = 0, fail = 0;
    for (const m of mails) {
      const r = await processMail(m);
      if (r.ok) ok++;
      else if (r.error === 'ignored') ignored++;
      else fail++;
    }
    console.log(`Done. ok=${ok} ignored=${ignored} fail=${fail}`);
    return;
  }

  const messageId = args[0];
  if (!messageId || messageId.startsWith('--')) {
    console.error('Usage: reparse-airbnb-mail.ts <message_id> [--force] | --all-errors [--slug=X]');
    process.exit(1);
  }
  const force = args.includes('--force');
  const row = getMail(messageId);
  if (!row) {
    console.error(`Mail with messageId '${messageId}' not found`);
    process.exit(1);
  }
  if (row.parse_status === 'ok' && !force) {
    console.log(`Already parsed ok. Use --force to re-parse.`);
    return;
  }
  const r = await processMail(row);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
