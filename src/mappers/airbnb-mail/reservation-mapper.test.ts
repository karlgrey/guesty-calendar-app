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
