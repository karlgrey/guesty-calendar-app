import { describe, it, expect } from 'vitest';
import { extractPricingFromReservation } from './document-service.js';

// Real-world example: UNvia GmbH / Janos Udvary (u19, airbnb2).
// fareAccommodation 318 + cleaning 25 = 343 list value (what the guest pays).
// Guesty subTotalPrice 262.96 is the host-reduced (post-commission) figure.
const airbnbMoney = {
  fareAccommodation: 318,
  fareCleaning: 25,
  subTotalPrice: 262.96,
  totalTaxes: 21.78,
  hostPayout: 284.74,
};

describe('extractPricingFromReservation — Airbnb full service value', () => {
  it('Airbnb invoice shows the full price the guest pays, not the commission-reduced amount', () => {
    const p = extractPricingFromReservation(
      { source: 'airbnb2', nightsCount: 2, guestsCount: 2, money: airbnbMoney },
      {}
    );
    // Option A: the subTotalPrice gap (commission) is NOT treated as a discount.
    expect(p.discountTotal).toBe(0);
    expect(p.subtotal).toBe(34300);          // 343.00 €
    expect(p.taxAmount).toBe(2178);          // 21.78 €
    expect(p.total).toBe(36478);             // 364.78 € (was 284.74 before the fix)
  });

  it('non-Airbnb bookings are unchanged (total = hostPayout, subtotal = Guesty subTotalPrice)', () => {
    const p = extractPricingFromReservation(
      { source: 'direct', nightsCount: 2, guestsCount: 2, money: airbnbMoney },
      {}
    );
    expect(p.subtotal).toBe(26296);          // 262.96 € (Guesty subTotalPrice)
    expect(p.total).toBe(28474);             // 284.74 € (hostPayout) — untouched
  });
});
