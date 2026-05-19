import { describe, it, expect } from 'vitest';
import { computeEffectivePayout } from './airbnb-payout.js';

describe('computeEffectivePayout', () => {
  it('Angela: matches the actual Airbnb payout of 636,52 €', () => {
    const out = computeEffectivePayout(
      { hostPayoutBrutto: 1043.9, cleaningFee: 120, totalPrice: 1310, occupancyTax: 30 },
      { coHostShareRate: 0.15, incomeTaxRate: 0.21 }
    );
    expect(out.coHostFee).toBe(138.58);   // 0.15 × 923.90 — banker's rounding
    expect(out.incomeTax).toBe(268.80);
    expect(out.hostPayoutEffective).toBe(636.52);
  });

  it('Wei An: matches the actual Airbnb payout of 508,95 €', () => {
    const out = computeEffectivePayout(
      { hostPayoutBrutto: 828.60, cleaningFee: 120, totalPrice: 1064, occupancyTax: 48 },
      { coHostShareRate: 0.15, incomeTaxRate: 0.21 }
    );
    expect(out.coHostFee).toBe(106.29);
    expect(out.incomeTax).toBe(213.36);
    expect(out.hostPayoutEffective).toBe(508.95);
  });

  it('returns brutto unchanged when both rates are 0 (Guesty/Hostex default)', () => {
    const out = computeEffectivePayout(
      { hostPayoutBrutto: 1000, cleaningFee: 100, totalPrice: 1200, occupancyTax: 0 },
      {}
    );
    expect(out.coHostFee).toBe(0);
    expect(out.incomeTax).toBe(0);
    expect(out.hostPayoutEffective).toBe(1000);
  });

  it('uses banker\'s rounding (138.585 → 138.58, not 138.59)', () => {
    const out = computeEffectivePayout(
      { hostPayoutBrutto: 1043.9, cleaningFee: 120, totalPrice: 0, occupancyTax: 0 },
      { coHostShareRate: 0.15, incomeTaxRate: 0 }
    );
    expect(out.coHostFee).toBe(138.58);
  });
});
