/**
 * Applies a parsed Airbnb payout mail to the database: stores per-reservation
 * contributions (idempotent) and updates reservations with the ground-truth
 * payout sum. Payout line items carry the FINAL stay dates, so they also
 * correct date drift for altered bookings (incl. past stays iCal can't see).
 */
import {
  insertPayoutItems, getPayoutSumByCode, setReservationPayoutConfirmed, updateReservationStay,
} from '../../repositories/airbnb-payout-repository.js';
import { getReservationById } from '../../repositories/reservation-repository.js';
import type { ParsedPayoutMail } from '../../parsers/airbnb-mail/payout.js';
import logger from '../../utils/logger.js';

export interface ApplyPayoutResult {
  matchedCodes: string[];
  unmatchedCodes: string[];
  dateCorrections: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function applyPayout(parsed: ParsedPayoutMail): ApplyPayoutResult {
  const byCode = new Map<string, { amount: number; listingId: string; stayStart: string; stayEnd: string }>();
  for (const item of parsed.items) {
    const cur = byCode.get(item.reservationCode);
    if (cur) {
      cur.amount = r2(cur.amount + item.amount);
    } else {
      byCode.set(item.reservationCode, {
        amount: item.amount, listingId: item.listingId,
        stayStart: item.stayStart, stayEnd: item.stayEnd,
      });
    }
  }

  insertPayoutItems(
    Array.from(byCode.entries()).map(([code, v]) => ({
      message_id: parsed.messageId,
      listing_id: v.listingId,
      reservation_code: code,
      payout_date: parsed.payoutDate,
      amount: v.amount,
      stay_start: v.stayStart,
      stay_end: v.stayEnd,
      total_mail_amount: parsed.totalAmount,
    }))
  );

  const result: ApplyPayoutResult = { matchedCodes: [], unmatchedCodes: [], dateCorrections: [] };

  for (const [code, v] of byCode) {
    const reservation = getReservationById(code);
    if (!reservation) {
      result.unmatchedCodes.push(code);
      logger.warn({ code, amount: v.amount }, 'Payout mail references unknown reservation — stored for later adoption');
      continue;
    }
    if (
      reservation.check_in_localized !== v.stayStart ||
      reservation.check_out_localized !== v.stayEnd
    ) {
      updateReservationStay(code, v.stayStart, v.stayEnd);
      result.dateCorrections.push(code);
    }
    setReservationPayoutConfirmed(code, getPayoutSumByCode(code).sum);
    result.matchedCodes.push(code);
  }
  return result;
}
