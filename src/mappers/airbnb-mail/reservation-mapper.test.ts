import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mapAirbnbReservation } from './reservation-mapper.js';
import type { ParsedAirbnbMail } from '../../types/airbnb-mail.js';

const base: ParsedAirbnbMail = {
  type: 'confirmed',
  reservationCode: 'HMABCXYZ',
  guestName: 'Anna Müller',
  checkIn: '2026-07-15',
  checkOut: '2026-07-18',
  numberOfGuests: 2,
  totalPrice: 300,
  hostPayout: 270,
  cleaningFee: 30,
  serviceFee: 15,
  receivedAt: '2026-05-18T09:00:00.000Z',
  messageId: 'test-1@airbnb.com',
};

const defaultTimes = { checkIn: '15:00', checkOut: '12:00' };

describe('mapAirbnbReservation', () => {
  describe('status routing', () => {
    it('confirmed → confirmed in both tables', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('confirmed');
    });

    it('inquiry → inquiry, no reservation', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'inquiry' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).toBeNull();
    });

    it('cancellation → canceled, no reservation', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'cancellation' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('canceled');
      expect(asReservation).toBeNull();
    });

    it('modification → confirmed (snapshot)', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'modification' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation!.status).toBe('confirmed');
    });
  });

  // #660: Storno-Mails ohne Datumsangaben ("Diese Reservierung wurde
  // storniert. Reservierungscode: HM…") liefern nur den Platzhalter
  // 1970-01-01 (siehe parseCancellation). Würde der Mapper den ins
  // inquiries-Upsert durchreichen, überschreibt das die echten Daten der
  // ursprünglichen Buchungsmail — und getCancelledReservationIds() (Fenster
  // heute±N Tage) findet die Stornierung danach nie mehr, das Google-Event
  // bleibt für immer stehen (Fall Mjalli Florenz, 15.09.2026).
  describe('cancellation date placeholder (#660)', () => {
    const placeholderCancellation = {
      ...base,
      type: 'cancellation' as const,
      checkIn: '1970-01-01',
      checkOut: '1970-01-01',
    };

    it('substitutes the existing inquiry dates when the cancellation mail carries the placeholder', () => {
      const { asInquiry } = mapAirbnbReservation(
        placeholderCancellation,
        '999',
        defaultTimes,
        undefined,
        { check_in: '2026-10-04', check_out: '2026-10-11' }
      );
      expect(asInquiry.check_in).toBe('2026-10-04');
      expect(asInquiry.check_out).toBe('2026-10-11');
    });

    it('falls back to the placeholder when there is no existing inquiry to recover dates from', () => {
      const { asInquiry } = mapAirbnbReservation(placeholderCancellation, '999', defaultTimes, undefined, null);
      expect(asInquiry.check_in).toBe('1970-01-01');
      expect(asInquiry.check_out).toBe('1970-01-01');
    });

    it('keeps the mail dates when the cancellation mail DOES carry real dates, even with an existing inquiry on file', () => {
      const withDates = { ...base, type: 'cancellation' as const, checkIn: '2026-07-20', checkOut: '2026-07-22' };
      const { asInquiry } = mapAirbnbReservation(withDates, '999', defaultTimes, undefined, {
        check_in: '2099-01-01',
        check_out: '2099-01-05',
      });
      expect(asInquiry.check_in).toBe('2026-07-20');
      expect(asInquiry.check_out).toBe('2026-07-22');
    });
  });

  describe('financial fields', () => {
    it('host_payout passed through', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.host_payout).toBe(270);
      expect(asReservation!.total_price).toBe(300);
    });

    it('host_payout = 0 when missing', () => {
      const noPayout = { ...base, hostPayout: undefined, totalPrice: undefined };
      const { asReservation } = mapAirbnbReservation(noPayout, '999', defaultTimes);
      expect(asReservation!.host_payout).toBe(0);
      expect(asReservation!.total_price).toBe(0);
    });
  });

  describe('date composition', () => {
    it('builds ISO check_in/check_out from date + default time', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.check_in).toBe('2026-07-15T15:00:00.000Z');
      expect(asReservation!.check_out).toBe('2026-07-18T12:00:00.000Z');
    });
  });

  describe('identifiers', () => {
    it('reservation_id = reservationCode', () => {
      const { asReservation, asInquiry } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.reservation_id).toBe('HMABCXYZ');
      expect(asInquiry.inquiry_id).toBe('HMABCXYZ');
    });

    it('listing_id from caller-supplied airbnbListingId', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.listing_id).toBe('999');
    });

    it('source = "airbnb"', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.source).toBe('airbnb');
    });
  });

  describe('guest fingerprint', () => {
    it('integrates fingerprintGuest', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.internal_guest_id).toBe('anna_mueller');
    });
  });
});
