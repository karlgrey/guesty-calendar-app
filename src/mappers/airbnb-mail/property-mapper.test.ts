import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mapAirbnbProperty } from './property-mapper.js';
import type { PropertyConfig } from '../../config/properties.js';

const baseConfig: PropertyConfig = {
  slug: 'schiffmuehle-x',
  provider: 'airbnb-mail',
  airbnbListingId: '987654321',
  airbnbIcalUrl: 'https://www.airbnb.com/calendar/ical/x.ics',
  name: 'Schiffmühle X',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  bookingRecipientEmail: 'a@b.de',
  bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 9 },
  ga4: { enabled: false },
  googleCalendar: { enabled: false },
  static: {
    accommodates: 4,
    bedrooms: 2,
    bathrooms: 1,
    propertyType: 'Apartment',
    cleaningFee: 30,
    extraPersonFee: 0,
    guestsIncluded: 4,
    weeklyPriceFactor: 0.9,
    monthlyPriceFactor: 0.8,
    taxes: [],
  },
};

describe('mapAirbnbProperty', () => {
  it('id from airbnbListingId', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.id).toBe('987654321');
  });

  it('accommodates and other static fields populated', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.accommodates).toBe(4);
    expect(l.bedrooms).toBe(2);
    expect(l.bathrooms).toBe(1);
    expect(l.property_type).toBe('Apartment');
    expect(l.cleaning_fee).toBe(30);
    expect(l.guests_included).toBe(4);
    expect(l.weekly_price_factor).toBe(0.9);
    expect(l.monthly_price_factor).toBe(0.8);
  });

  it('base_price = 0 when not in static', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.base_price).toBe(0);
  });

  it('base_price from static.basePrice when set', () => {
    const cfg = { ...baseConfig, static: { ...baseConfig.static!, basePrice: 150 } };
    const l = mapAirbnbProperty(cfg);
    expect(l.base_price).toBe(150);
  });

  it('min_nights default 1', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.min_nights).toBe(1);
  });

  it('max_nights default null', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.max_nights).toBeNull();
  });

  it('throws when static is missing', () => {
    const noStatic = { ...baseConfig, static: undefined };
    expect(() => mapAirbnbProperty(noStatic)).toThrow(/static config/);
  });

  it('active is always true', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.active).toBe(true);
  });

  it('nickname = propertyConfig.name', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.nickname).toBe('Schiffmühle X');
  });
});
