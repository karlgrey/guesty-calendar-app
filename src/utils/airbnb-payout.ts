/**
 * Effective host-payout calculation for Airbnb-mail provider.
 *
 * The Airbnb booking-confirmation mail's "Du verdienst" value is the BRUTTO
 * host payout — it deducts Airbnb's service fee but NOT:
 *   • the co-host's share (e.g. 15 % of stay-after-anpassung, equivalent to
 *     15 % of (brutto-payout − cleaning-fee))
 *   • country-specific income tax withholding (Italy: 21 % "cedolare secca"
 *     on stay+cleaning = total_price − occupancy_tax)
 *
 * Both deductions apply to the host. Pass the rates from the property's
 * static config; default 0 means no deduction (current Guesty/Hostex behaviour).
 *
 * Reference: validated against live Airbnb host data (May 2026, Firenze).
 *   Wei An: 828,60 − 0.15·(828,60 − 120) − 0.21·(1064 − 48)
 *         = 828,60 − 106,29 − 213,36 = 508,95 € (matches "Auszahlung an Co-Host"
 *         + actual Airbnb payout breakdown).
 *   Angela: 1043,90 − 0.15·(1043,90 − 120) − 0.21·(1310 − 30)
 *         = 1043,90 − 138,585 − 268,80 = 636,52 € (matches the "Wir haben eine
 *         Auszahlung in Höhe von 636,52 € EUR gesendet" mail).
 */

export interface PayoutInputs {
  hostPayoutBrutto: number | undefined;
  cleaningFee: number | undefined;
  totalPrice: number | undefined;
  occupancyTax: number | undefined;
}

export interface PayoutRates {
  coHostShareRate?: number;
  incomeTaxRate?: number;
}

export interface PayoutBreakdown {
  hostPayoutBrutto: number;
  coHostFee: number;
  incomeTax: number;
  hostPayoutEffective: number;
}

// Banker's rounding (round half to even) — matches Airbnb's displayed cents.
// Example: 138.585 → 138.58 (8 is even), not 138.59 as Math.round would give.
function r2(n: number): number {
  const cents = n * 100;
  const floor = Math.floor(cents);
  const diff = cents - floor;
  let rounded: number;
  if (diff < 0.5) rounded = floor;
  else if (diff > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / 100;
}

export function computeEffectivePayout(
  inputs: PayoutInputs,
  rates: PayoutRates
): PayoutBreakdown {
  const brutto = inputs.hostPayoutBrutto ?? 0;
  const cleaning = inputs.cleaningFee ?? 0;
  const total = inputs.totalPrice ?? 0;
  const occupancyTax = inputs.occupancyTax ?? 0;

  const coHostRate = rates.coHostShareRate ?? 0;
  const taxRate = rates.incomeTaxRate ?? 0;

  const coHostFee = r2(coHostRate * (brutto - cleaning));
  const incomeTax = r2(taxRate * (total - occupancyTax));
  const effective = r2(brutto - coHostFee - incomeTax);

  return {
    hostPayoutBrutto: r2(brutto),
    coHostFee,
    incomeTax,
    hostPayoutEffective: effective,
  };
}
