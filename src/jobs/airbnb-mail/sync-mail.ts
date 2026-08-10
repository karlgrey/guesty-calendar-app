/**
 * Airbnb Sync Mail
 *
 * IMAP poll: fetch new mails since last UID, archive raw bodies, detect type,
 * parse, and persist to inquiries + reservations. Final step: prune archive
 * older than 90 days.
 */

import { config } from '../../config/index.js';
import { AirbnbImapClient } from '../../services/airbnb-mail/imap-client.js';
import {
  insertMail,
  updateParseStatus,
  getLastUid,
  setLastUid,
  pruneOldMails,
} from '../../repositories/airbnb-mail-archive-repository.js';
import { detectMailType } from '../../parsers/airbnb-mail/index.js';
import { parseConfirmedBooking } from '../../parsers/airbnb-mail/confirmed-booking.js';
import { parseBookingInquiry } from '../../parsers/airbnb-mail/booking-inquiry.js';
import { parseCancellation } from '../../parsers/airbnb-mail/cancellation.js';
import { parsePayoutMail } from '../../parsers/airbnb-mail/payout.js';
import { applyPayout } from '../../services/airbnb-mail/payout-applier.js';
import {
  getPayoutSumByCode,
  setReservationPayoutConfirmed,
  setPayoutStatus,
} from '../../repositories/airbnb-payout-repository.js';
import { mapAirbnbReservation } from '../../mappers/airbnb-mail/reservation-mapper.js';
import { upsertReservation } from '../../repositories/reservation-repository.js';
import { getDatabase } from '../../db/index.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { RawMail, AirbnbMailType, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export interface SyncMailResult {
  success: boolean;
  fetched: number;
  parsedOk: number;
  confirmedCount: number;  // bookings that resulted in an active reservation row
  parsedError: number;
  ignoredCount: number;    // mails with unrecognised Subject (account-mgmt, threads, 2FA, payouts, etc.)
  prunedArchive: number;
  error?: string;
}

function dispatchParser(type: AirbnbMailType, raw: RawMail): ParsedAirbnbMail | null {
  switch (type) {
    case 'confirmed': return parseConfirmedBooking(raw);
    case 'inquiry': return parseBookingInquiry(raw);
    case 'cancellation': return parseCancellation(raw);
    // 'modification' is handled at the dispatcher level (marked ignored), so
    // it should never reach this switch.
    default: return null;
  }
}

export async function syncAirbnbMail(property: PropertyConfig): Promise<SyncMailResult> {
  const slug = property.slug;
  const airbnbListingId = property.airbnbListingId!;
  if (!config.airbnbMailHost || !config.airbnbMailUser || !config.airbnbMailPassword) {
    return { success: false, fetched: 0, parsedOk: 0, confirmedCount: 0, parsedError: 0, ignoredCount: 0, prunedArchive: 0,
             error: 'AIRBNB_MAIL_* env-vars not configured' };
  }

  const defaultTimes = {
    checkIn: property.googleCalendar?.checkInTime ?? '15:00',
    checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
  };

  const client = new AirbnbImapClient({
    host: config.airbnbMailHost,
    port: config.airbnbMailPort,
    user: config.airbnbMailUser,
    password: config.airbnbMailPassword,
    mailbox: property.airbnbMailLabel ?? 'INBOX',
  });

  let fetched = 0;
  let parsedOk = 0;
  let confirmedCount = 0;
  let parsedError = 0;
  let ignoredCount = 0;

  try {
    await client.connect();
    const lastUid = getLastUid(slug);
    const mails = await client.fetchNewMails(lastUid);
    fetched = mails.length;
    logger.info({ slug, fetched, sinceUid: lastUid }, 'Airbnb mail: fetched new mails');

    const db = getDatabase();
    const upsertInquiry = db.prepare(`
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
    `);

    const deleteReservation = db.prepare(`DELETE FROM reservations WHERE reservation_id = ?`);
    let maxUid = lastUid;

    for (const raw of mails) {
      // UID must advance past this mail regardless of what happens below —
      // otherwise a single bad mail wedges the property's ingest forever
      // (next run refetches the same batch, hits the same failure again).
      maxUid = Math.max(maxUid, raw.uid);

      // Everything below is scoped to THIS mail. A failure anywhere here
      // (archiving, parsing, mapping, persisting) must not abort the batch —
      // it would silently drop every mail after it in this run, and — since
      // setLastUid() only runs after the loop completes — permanently wedge
      // the property at this UID on every future run too.
      try {
        // Archive raw first
        insertMail({
          property_slug: slug,
          message_id: raw.messageId,
          imap_uid: raw.uid,
          subject: raw.subject,
          from_address: raw.fromAddress,
          received_at: raw.receivedAt,
          raw_body: raw.htmlBody || raw.textBody,
          detected_type: null,
          reservation_code: null,
          parse_status: 'pending',
          parse_error: null,
        });

        const type = detectMailType(raw.subject);
        if (type === 'unknown') {
          // Not a booking-relevant Subject (account-management, message threads,
          // 2FA, payouts, etc.). Archive for audit, but do not flag as error.
          updateParseStatus(raw.messageId, 'ignored', `Unrecognised Subject: ${raw.subject}`, null, type);
          ignoredCount++;
          logger.debug({ slug, messageId: raw.messageId, subject: raw.subject }, 'Airbnb mail: ignored (unrecognised subject)');
          continue;
        }
        if (type === 'modification') {
          // Modification mails (Buchungsänderung/aktualisiert/"möchte die Buchung
          // ändern") carry no reliable reservation code or dates — the iCal
          // reconciliation (reconcile-ical.ts) corrects dates, payout mails
          // correct amounts. Archive for audit and skip parsing.
          updateParseStatus(raw.messageId, 'ignored', 'modification: handled by iCal reconciliation', null, type);
          ignoredCount++;
          continue;
        }
        if (type === 'payout') {
          const payout = parsePayoutMail(raw);
          if (!payout) {
            updateParseStatus(raw.messageId, 'error', 'Payout parser returned null', null, type);
            parsedError++;
          } else if (payout.items.length === 0) {
            // Subject matched but the body yielded no line items — likely an
            // HTML format drift in the item regex, not a "nothing to apply"
            // mail. Flag it as an error so it surfaces for a look, instead of
            // silently swallowing a payout that was never actually applied.
            updateParseStatus(raw.messageId, 'error', 'Payout mail parsed but 0 line items — format drift?', null, type);
            parsedError++;
            logger.warn({ slug, messageId: raw.messageId }, 'Airbnb mail: payout mail parsed but 0 line items — format drift?');
          } else {
            const applied = applyPayout(payout);
            updateParseStatus(
              raw.messageId, 'ok', null,
              applied.matchedCodes[0] ?? applied.unmatchedCodes[0] ?? null, type
            );
            parsedOk++;
            logger.info({ slug, ...applied, total: payout.totalAmount }, 'Airbnb mail: payout applied');
          }
          continue;
        }

        const parsed = dispatchParser(type, raw);
        if (!parsed) {
          updateParseStatus(raw.messageId, 'error', 'Parser returned null (missing fields)', null, type);
          parsedError++;
          logger.warn({ slug, messageId: raw.messageId, type }, 'Airbnb mail: parser returned null');
          continue;
        }

        const { asInquiry, asReservation } = mapAirbnbReservation(parsed, airbnbListingId, defaultTimes, {
          coHostShareRate: property.static?.coHostShareRate,
          incomeTaxRate: property.static?.incomeTaxRate,
        });

        upsertInquiry.run(
          asInquiry.inquiry_id,
          asInquiry.listing_id,
          asInquiry.status,
          asInquiry.check_in,
          asInquiry.check_out,
          asInquiry.guest_name,
          asInquiry.guests_count,
          asInquiry.source,
          asInquiry.created_at_guesty,
          asInquiry.last_synced_at,
        );

        if (asReservation) {
          upsertReservation(asReservation);
          confirmedCount++;
          // Migration 022's column DEFAULT 'confirmed' only covers rows that
          // existed at migration time — upsertReservation() doesn't know the
          // payout_status column (kept out of the Reservation TS type on
          // purpose), so every NEW confirmed booking must be explicitly set
          // here, same as reconcile-ical.ts / payout-applier.ts do.
          const sum = getPayoutSumByCode(parsed.reservationCode);
          if (sum.count > 0) {
            setReservationPayoutConfirmed(parsed.reservationCode, sum.sum);
          } else {
            setPayoutStatus(parsed.reservationCode, 'estimated');
          }
        } else if (type === 'cancellation') {
          // Cancellation mail → remove any existing reservation row
          deleteReservation.run(parsed.reservationCode);
        }

        updateParseStatus(raw.messageId, 'ok', null, parsed.reservationCode, type);
        parsedOk++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'unknown error';
        parsedError++;
        logger.error(
          { slug, messageId: raw.messageId, uid: raw.uid, error: errMsg },
          'Airbnb mail: processing this mail failed unexpectedly — skipping it, UID still advances'
        );
        // Best-effort status update — the row may not exist if insertMail()
        // itself is what threw, so this can legitimately no-op.
        try {
          updateParseStatus(raw.messageId, 'error', errMsg, null, null);
        } catch {
          // ignore — already logged above
        }
      }
    }

    // Always persist, even when maxUid === lastUid (no new mail this run).
    // last_sync_at doubles as the "last successful poll" signal for the
    // staleness alarm (#327) — a quiet mailbox is a successful sync, and must
    // not look identical to a broken IMAP login just because nothing new
    // arrived. Idempotent when the UID hasn't moved.
    setLastUid(slug, maxUid);

    // No stale-delete pass: airbnb-mail is a delta-update source, not a snapshot.
    // Cancellations remove rows directly above. If a cancellation mail ever gets
    // lost the orphan row needs manual cleanup (or future iCal-based reconciliation).

    const prunedArchive = pruneOldMails(90);

    return { success: true, fetched, parsedOk, confirmedCount, parsedError, ignoredCount, prunedArchive };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb mail sync failed');
    return {
      success: false, fetched, parsedOk, confirmedCount, parsedError, ignoredCount, prunedArchive: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    await client.disconnect();
  }
}
