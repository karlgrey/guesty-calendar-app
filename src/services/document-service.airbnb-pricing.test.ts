import { describe, it, expect } from 'vitest';
import { extractPricingFromReservation } from './document-service.js';

// Real-world example: UNvia GmbH / Janos Udvary (u19, airbnb2).
// AF 318 + CF 25, LengthOfStayDiscount -31.80 (real guest discount),
// host channel fee (PCM) -48.24 (Airbnb commission — NOT a guest discount).
// fareAccommodationAdjusted 286.20 = 318 - 31.80 (accommodation net of guest discount).
// What the guest actually pays = 286.20 + 25 + 21.78 tax = 332.98 (= Airbnb's "guest paid").
const airbnbMoney = {
  fareAccommodation: 318,
  fareAccommodationAdjusted: 286.2,
  fareCleaning: 25,
  subTotalPrice: 262.96,   // host-side (after commission) — must NOT drive the invoice
  totalTaxes: 21.78,
  hostPayout: 284.74,
};

describe('extractPricingFromReservation — Airbnb invoice = what the guest pays', () => {
  it('Airbnb invoice includes the real guest discount but excludes the host channel fee', () => {
    const p = extractPricingFromReservation(
      { source: 'airbnb2', nightsCount: 2, guestsCount: 2, money: airbnbMoney },
      {}
    );
    // discount = fareAccommodationAdjusted - fareAccommodation = -31.80 (the LOSD), not the commission.
    expect(p.discountTotal).toBe(-3180);     // -31.80 €
    expect(p.subtotal).toBe(31120);          // 311.20 € (286.20 + 25)
    expect(p.taxAmount).toBe(2178);          // 21.78 €
    expect(p.total).toBe(33298);             // 332.98 € — exactly what the guest paid
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
