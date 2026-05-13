import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing mapper to avoid pulling in config/env validation
vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { mapHostexReservation } from './reservation-mapper.js';
import type { HostexReservation } from '../../types/hostex.js';

const baseRes: HostexReservation = {
  reservation_code: 'R-001',
  stay_code: 'R-001',
  channel_id: 'AIRBNB-XYZ',
  channel_type: 'airbnb',
  listing_id: '1635436646666826858',
  property_id: 12659676,
  status: 'accepted',
  check_in_date: '2026-06-01',
  check_out_date: '2026-06-03',
  number_of_guests: 2,
  number_of_adults: 2,
  number_of_children: 0,
  number_of_infants: 0,
  guest_name: 'Anke Morgenroth',
  rates: {
    total_rate: { currency: 'EUR', amount: 300 },
    total_commission: { currency: 'EUR', amount: 45 },
    details: [
      { type: 'ACCOMMODATION', description: 'Accommodation', currency: 'EUR', amount: 260 },
      { type: 'CLEANING_FEE', description: 'Cleaning fee', currency: 'EUR', amount: 40 },
      { type: 'HOST_SERVICE_FEE', description: 'Commission', currency: 'EUR', amount: 45 },
    ],
  },
  booked_at: '2026-05-01T10:00:00+00:00',
  created_at: '2026-05-01T10:00:00+00:00',
};

const defaultTimes = { checkIn: '15:00', checkOut: '12:00' };

describe('mapHostexReservation', () => {
  describe('Status-Routing', () => {
    it('accepted → confirmed in both tables', () => {
      const { asInquiry, asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('confirmed');
    });

    it('wait_pay → reserved in both tables', () => {
      const r = { ...baseRes, status: 'wait_pay' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('reserved');
      expect(asReservation!.status).toBe('reserved');
    });

    it('wait_accept → inquiry only', () => {
      const r = { ...baseRes, status: 'wait_accept' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).toBeNull();
    });

    it('cancelled → canceled inquiry only', () => {
      const r = { ...baseRes, status: 'cancelled' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('canceled');
      expect(asReservation).toBeNull();
    });

    it('denied → declined inquiry only', () => {
      const r = { ...baseRes, status: 'denied' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('declined');
      expect(asReservation).toBeNull();
    });

    it('timeout → expired inquiry only', () => {
      const r = { ...baseRes, status: 'timeout' as const };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('expired');
      expect(asReservation).toBeNull();
    });

    it('unknown status → defensive reserved in both tables', () => {
      const r = { ...baseRes, status: 'some_new_status' };
      const { asInquiry, asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('reserved');
    });
  });

  describe('Financial fields', () => {
    it('host_payout = total_rate - total_commission', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.host_payout).toBe(255); // 300 - 45
      expect(asReservation!.total_price).toBe(300);
    });

    it('handles missing rates gracefully', () => {
      const r = { ...baseRes, rates: undefined };
      const { asReservation } = mapHostexReservation(r, defaultTimes);
      expect(asReservation!.host_payout).toBe(0);
      expect(asReservation!.total_price).toBe(0);
    });
  });

  describe('Date/time composition', () => {
    it('combines check_in_date with defaultCheckIn time as ISO', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.check_in).toBe('2026-06-01T15:00:00.000Z');
      expect(asReservation!.check_out).toBe('2026-06-03T12:00:00.000Z');
    });
  });

  describe('Identifiers', () => {
    it('reservation_id = Hostex reservation_code', () => {
      const { asReservation, asInquiry } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.reservation_id).toBe('R-001');
      expect(asInquiry.inquiry_id).toBe('R-001');
    });

    it('listing_id = Hostex property_id as string', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.listing_id).toBe('12659676');
    });

    it('source = Hostex channel_type', () => {
      const { asReservation, asInquiry } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.source).toBe('airbnb');
      expect(asInquiry.source).toBe('airbnb');
    });
  });

  describe('Guest fingerprint', () => {
    it('integrates fingerprintGuestSafe', () => {
      const { asReservation } = mapHostexReservation(baseRes, defaultTimes);
      expect(asReservation!.internal_guest_id).toBe('anke_morgenroth');
      expect(asReservation!.guest_company).toBeNull();
    });
  });
});
