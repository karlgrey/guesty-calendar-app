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
import { parseModification } from '../../parsers/airbnb-mail/modification.js';
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
  parsedError: number;
  prunedArchive: number;
  error?: string;
}

function dispatchParser(type: AirbnbMailType, raw: RawMail): ParsedAirbnbMail | null {
  switch (type) {
    case 'confirmed': return parseConfirmedBooking(raw);
    case 'inquiry': return parseBookingInquiry(raw);
    case 'cancellation': return parseCancellation(raw);
    case 'modification': return parseModification(raw);
    default: return null;
  }
}

export async function syncAirbnbMail(property: PropertyConfig): Promise<SyncMailResult> {
  const slug = property.slug;
  const airbnbListingId = property.airbnbListingId!;
  if (!config.airbnbMailHost || !config.airbnbMailUser || !config.airbnbMailPassword) {
    return { success: false, fetched: 0, parsedOk: 0, parsedError: 0, prunedArchive: 0,
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
  });

  let fetched = 0;
  let parsedOk = 0;
  let parsedError = 0;

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
      maxUid = Math.max(maxUid, raw.uid);

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
        updateParseStatus(raw.messageId, 'error', `Unknown subject pattern: ${raw.subject}`, null, type);
        parsedError++;
        logger.warn({ slug, messageId: raw.messageId, subject: raw.subject }, 'Airbnb mail: unknown subject pattern');
        continue;
      }

      try {
        const parsed = dispatchParser(type, raw);
        if (!parsed) {
          updateParseStatus(raw.messageId, 'error', 'Parser returned null (missing fields)', null, type);
          parsedError++;
          logger.warn({ slug, messageId: raw.messageId, type }, 'Airbnb mail: parser returned null');
          continue;
        }

        const { asInquiry, asReservation } = mapAirbnbReservation(parsed, airbnbListingId, defaultTimes);

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
        } else if (type === 'cancellation') {
          // Cancellation mail → remove any existing reservation row
          deleteReservation.run(parsed.reservationCode);
        }

        updateParseStatus(raw.messageId, 'ok', null, parsed.reservationCode, type);
        parsedOk++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'unknown error';
        updateParseStatus(raw.messageId, 'error', errMsg, null, type);
        parsedError++;
        logger.warn({ slug, messageId: raw.messageId, type, error: errMsg }, 'Airbnb mail: parse threw');
      }
    }

    if (maxUid > lastUid) setLastUid(slug, maxUid);

    // No stale-delete pass: airbnb-mail is a delta-update source, not a snapshot.
    // Cancellations remove rows directly above. If a cancellation mail ever gets
    // lost the orphan row needs manual cleanup (or future iCal-based reconciliation).

    const prunedArchive = pruneOldMails(90);

    return { success: true, fetched, parsedOk, parsedError, prunedArchive };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb mail sync failed');
    return {
      success: false, fetched, parsedOk, parsedError, prunedArchive: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    await client.disconnect();
  }
}
