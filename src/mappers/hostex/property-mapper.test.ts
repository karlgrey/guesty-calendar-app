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

import { mapHostexProperty } from './property-mapper.js';
import type { HostexProperty, HostexReservation, HostexCalendarDay } from '../../types/hostex.js';
import type { PropertyConfig } from '../../config/properties.js';

const hostexProperty: HostexProperty = {
  id: 12659676,
  title: 'Alte Schilderwerkstatt',
  channels: [{ channel_type: 'airbnb', listing_id: 'L1', currency: 'EUR' }],
  default_checkin_time: '15:00',
  default_checkout_time: '12:00',
  timezone: 'Europe/Berlin',
};

const basePropertyConfig: PropertyConfig = {
  slug: 'alte-schilderwerkstatt',
  provider: 'hostex',
  hostexPropertyId: '12659676',
  name: 'Alte Schilderwerkstatt',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  bookingRecipientEmail: 'a@b.de',
  bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 9 },
  ga4: { enabled: false },
  googleCalendar: { enabled: false },
  static: { accommodates: 4 },
};

const calendarSample: HostexCalendarDay[] = [
  { date: '2026-06-01', price: 129, inventory: 1, restrictions: { min_stay_on_arrival: 1, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-02', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-03', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-04', price: 199, inventory: 1, restrictions: { min_stay_on_arrival: 3, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
  { date: '2026-06-05', price: 149, inventory: 1, restrictions: { min_stay_on_arrival: 2, max_stay_on_arrival: 365, closed_on_arrival: false, closed_on_departure: false } },
];

const recentReservations: HostexReservation[] = [
  { reservation_code: 'R1', stay_code: 'R1', channel_id: 'a', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-01', check_out_date: '2026-04-02',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 20 }] } },
  { reservation_code: 'R2', stay_code: 'R2', channel_id: 'b', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-05', check_out_date: '2026-04-06',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 25 }] } },
  { reservation_code: 'R3', stay_code: 'R3', channel_id: 'c', channel_type: 'airbnb', listing_id: 'L1', property_id: 12659676, status: 'accepted', check_in_date: '2026-04-10', check_out_date: '2026-04-11',
    rates: { details: [{ type: 'CLEANING_FEE', description: '', currency: 'EUR', amount: 30 }] } },
];

describe('mapHostexProperty', () => {
  describe('basic fields', () => {
    it('id from hostexProperty.id as string', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.id).toBe('12659676');
    });
    it('title pass-through', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.title).toBe('Alte Schilderwerkstatt');
    });
    it('active is always true', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.active).toBe(true);
    });
  });

  describe('Static-First (priority over Dynamic and API)', () => {
    it('static.basePrice wins over calendar median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, basePrice: 500 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.base_price).toBe(500);
    });
    it('static.cleaningFee wins over reservation median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, cleaningFee: 99 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations, calendarSample: [] });
      expect(l.cleaning_fee).toBe(99);
    });
    it('static.minNights wins over restriction median', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, minNights: 7 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.min_nights).toBe(7);
    });
    it('static.maxNights wins over restriction max', () => {
      const config = { ...basePropertyConfig, static: { accommodates: 4, maxNights: 14 } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample });
      expect(l.max_nights).toBe(14);
    });
  });

  describe('Dynamic-Fallback', () => {
    it('base_price = median calendar price when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.base_price).toBe(149); // median of [129, 149, 149, 199, 149]
    });
    it('cleaning_fee = median CLEANING_FEE from recent reservations', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations, calendarSample: [] });
      expect(l.cleaning_fee).toBe(25); // median of [20, 25, 30]
    });
    it('min_nights = median min_stay_on_arrival when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.min_nights).toBe(2); // median of [1, 2, 2, 3, 2]
    });
    it('max_nights = max max_stay_on_arrival when static null', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample });
      expect(l.max_nights).toBe(365);
    });
  });

  describe('Final fallbacks', () => {
    it('base_price = 0 when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.base_price).toBe(0);
    });
    it('cleaning_fee = 0 when both static and reservations empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.cleaning_fee).toBe(0);
    });
    it('min_nights = 1 when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.min_nights).toBe(1);
    });
    it('max_nights = null when both static and calendar empty', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.max_nights).toBeNull();
    });
  });

  describe('Static optional fields', () => {
    it('full static block populates everything', () => {
      const config = { ...basePropertyConfig, static: {
        accommodates: 6, bedrooms: 3, bathrooms: 2, propertyType: 'House',
        extraPersonFee: 30, guestsIncluded: 4, weeklyPriceFactor: 0.85, monthlyPriceFactor: 0.7,
        taxes: [{ type: 'VAT', amount: 7, units: 'PERCENTAGE' as const, quantifier: 'PER_NIGHT' as const }],
      } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample: [] });
      expect(l.accommodates).toBe(6);
      expect(l.bedrooms).toBe(3);
      expect(l.bathrooms).toBe(2);
      expect(l.property_type).toBe('House');
      expect(l.extra_person_fee).toBe(30);
      expect(l.guests_included).toBe(4);
      expect(l.weekly_price_factor).toBe(0.85);
      expect(l.monthly_price_factor).toBe(0.7);
      expect(l.taxes).toHaveLength(1);
      expect(l.taxes[0].type).toBe('VAT');
    });
    it('guests_included defaults to accommodates if not set', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.guests_included).toBe(4);
    });
  });

  describe('Check-in/out times', () => {
    it('googleCalendar.checkInTime wins over hostex default', () => {
      const config = { ...basePropertyConfig, googleCalendar: { enabled: true, checkInTime: '16:00', checkOutTime: '11:00' } };
      const l = mapHostexProperty({ hostexProperty, propertyConfig: config, recentReservations: [], calendarSample: [] });
      expect(l.check_in_time).toBe('16:00');
      expect(l.check_out_time).toBe('11:00');
    });
    it('falls back to hostex default_checkin_time', () => {
      const l = mapHostexProperty({ hostexProperty, propertyConfig: basePropertyConfig, recentReservations: [], calendarSample: [] });
      expect(l.check_in_time).toBe('15:00');
      expect(l.check_out_time).toBe('12:00');
    });
  });
});
