// #1242: Gast-Gesamtbetrag laut Airbnb — Rückrechnung aus der Netto-Auszahlung bei Anfragen,
// echte Werte bei bestätigten Buchungen. Zahlen aus dem Live-Befund vom 19.11.2026 (Guesty).
import { describe, it, expect } from 'vitest';
import {
  estimateAirbnbGuestTotal,
  classifyGuestyGuestPrice,
  resolveGuestPrice,
  channelName,
} from './guest-price.js';

const RATES = { hostServiceFeeRate: 0.155, taxRate: 0.07 };

describe('estimateAirbnbGuestTotal', () => {
  it('Fall Daniel: 3.118,05 Auszahlung → 3.690,00 ohne Steuer, 3.948,30 mit 7 %', () => {
    expect(estimateAirbnbGuestTotal(3118.05, RATES)).toEqual({ exclTax: 3690, tax: 258.3, inclTax: 3948.3 });
  });

  it('U19-Paar: 151,25 → 179,00 (nicht 178,99) → 191,53 mit Steuer', () => {
    // 151,25 / 0,845 = 178,994…; Airbnb rundet die Gebühr (27,745 → 27,75), Gastbetrag 139 + 40 = 179
    expect(estimateAirbnbGuestTotal(151.25, RATES)).toEqual({ exclTax: 179, tax: 12.53, inclTax: 191.53 });
  });

  it.each([
    // [Auszahlung Anfrage, Gastbetrag ohne Steuer, Steuer, Gastbetrag mit Steuer] — Paare Anfrage/Buchung
    [3422.25, 4050, 283.5, 4333.5], // Farmhouse 3.700 + 350 Reinigung
    [3527.87, 4175, 292.25, 4467.25], // Farmhouse 3.825 + 350, Gebühr 647,125 → 647,13
    [245.22, 290.2, 20.31, 310.51], // U19 278 − 27,80 Rabatt + 40
  ])('Rückrechnung %s → %s + %s = %s', (net, excl, tax, incl) => {
    expect(estimateAirbnbGuestTotal(net, RATES)).toEqual({ exclTax: excl, tax, inclTax: incl });
  });

  it('nicht eindeutige Rückrechnung weicht höchstens 1 Cent ab (U19 417 − 62,55 + 35 = 389,45, Steuer 27,26)', () => {
    // Auszahlung 329,09 passt zu 389,45 UND 389,46 (Gebühr 60,36 bzw. 60,37) — „ca." im Text deckt das ab
    const e = estimateAirbnbGuestTotal(329.09, RATES)!;
    expect(Math.abs(e.exclTax - 389.45)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(e.inclTax - 416.71)).toBeLessThanOrEqual(0.011);
  });

  it('Steuersatz 0 → mit und ohne Steuer gleich', () => {
    expect(estimateAirbnbGuestTotal(3118.05, { hostServiceFeeRate: 0.155, taxRate: 0 })).toEqual({ exclTax: 3690, tax: 0, inclTax: 3690 });
  });

  it('ungültige Eingaben → null', () => {
    expect(estimateAirbnbGuestTotal(0, RATES)).toBeNull();
    expect(estimateAirbnbGuestTotal(-5, RATES)).toBeNull();
    expect(estimateAirbnbGuestTotal(Number.NaN, RATES)).toBeNull();
    expect(estimateAirbnbGuestTotal(100, { hostServiceFeeRate: 1, taxRate: 0.07 })).toBeNull();
  });
});

/** Guesty-Reservierung mit money-Block (nur die Felder, die Liste und Einzelabruf liefern). */
function guesty(source: string, money: Record<string, unknown>) {
  return { _id: 'X', source, money: { currency: 'EUR', ...money } };
}

describe('classifyGuestyGuestPrice', () => {
  it('Airbnb-Anfrage nur mit Netto-Position (Fall Daniel) → net_payout, kein Gastbetrag', () => {
    const r = guesty('airbnb2', {
      fareAccommodation: 3118.05, fareAccommodationAdjusted: 3118.05, fareCleaning: 0, totalTaxes: 0,
      hostServiceFee: 0, subTotalPrice: 3118.05, hostPayout: 3118.05,
    });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: 'net_payout' });
  });

  it('bestätigte Airbnb-Buchung → echter Gastbetrag = fareAccommodationAdjusted + Reinigung + Steuern', () => {
    const r = guesty('airbnb2', {
      fareAccommodation: 3600, fareAccommodationAdjusted: 3300, fareCleaning: 350, totalTaxes: 255.5,
      hostServiceFee: 565.75, subTotalPrice: 3084.25, hostPayout: 3339.75,
    });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: 3905.5, price_basis: 'guest_total' });
  });

  it('U19-Buchung: 139 + 40 + 12,53 = 191,53', () => {
    const r = guesty('airbnb2', {
      fareAccommodationAdjusted: 139, fareCleaning: 40, totalTaxes: 12.53, hostServiceFee: 27.75, hostPayout: 163.78,
    });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: 191.53, price_basis: 'guest_total' });
  });

  it('ältere Airbnb-Anfrage mit Guesty-eigener Aufstellung (Reinigung > 0, keine Gebühr) → accommodation', () => {
    const r = guesty('airbnb2', {
      fareAccommodation: 3000, fareAccommodationAdjusted: 4400, fareCleaning: 350, totalTaxes: 0,
      hostServiceFee: 0, subTotalPrice: 4750, hostPayout: 4750,
    });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: 'accommodation' });
  });

  it('Direktbuchung (kein Airbnb) → accommodation', () => {
    const r = guesty('manual', { fareAccommodationAdjusted: 900, fareCleaning: 350, totalTaxes: 87.5, hostServiceFee: 0, hostPayout: 1250 });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: 'accommodation' });
  });

  it('Airbnb über integration.platform erkannt, auch ohne source', () => {
    const r = { _id: 'X', integration: { platform: 'airbnb2' }, money: { fareAccommodationAdjusted: 100, fareCleaning: 0, totalTaxes: 0, hostServiceFee: 0, hostPayout: 100 } };
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: 'net_payout' });
  });

  it('stornierte Airbnb-Buchung mit Nullwerten → unbekannt', () => {
    const r = guesty('airbnb2', { fareAccommodationAdjusted: 0, fareCleaning: 0, totalTaxes: 0, hostServiceFee: 0, hostPayout: 0 });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: null });
  });

  it('Airbnb ohne Aufschlüsselungsfelder (z. B. alter Listen-Payload) → unbekannt statt raten', () => {
    const r = guesty('airbnb2', { fareAccommodationAdjusted: 3118.05, hostPayout: 3118.05 });
    expect(classifyGuestyGuestPrice(r)).toEqual({ guest_total: null, price_basis: null });
  });

  it('ohne money → unbekannt', () => {
    expect(classifyGuestyGuestPrice({ _id: 'X', source: 'airbnb2' })).toEqual({ guest_total: null, price_basis: null });
  });
});

describe('resolveGuestPrice', () => {
  const base = { source: 'airbnb2', currency: 'EUR', total_price: 3118.05, host_payout: 3118.05 };

  it('net_payout + Sätze → geschätzt (mit Steuer Hauptwert, ohne Steuer Nebenwert)', () => {
    expect(resolveGuestPrice({ ...base, price_basis: 'net_payout', guest_total: null }, RATES)).toEqual({
      kind: 'estimated', inclTax: 3948.3, exclTax: 3690, currency: 'EUR', channel: 'Airbnb',
    });
  });

  it('net_payout ohne konfigurierte Sätze → null (die Auszahlung ist kein Gastpreis)', () => {
    expect(resolveGuestPrice({ ...base, price_basis: 'net_payout', guest_total: null }, undefined)).toBeNull();
  });

  it('guest_total → echter Wert', () => {
    expect(resolveGuestPrice({ ...base, price_basis: 'guest_total', guest_total: 191.53 }, RATES)).toEqual({
      kind: 'actual', total: 191.53, currency: 'EUR', channel: 'Airbnb',
    });
  });

  it('accommodation → Übernachtungspreis aus total_price', () => {
    expect(resolveGuestPrice({ ...base, total_price: 4400, host_payout: 4750, price_basis: 'accommodation', guest_total: null }, RATES)).toEqual({
      kind: 'accommodation', amount: 4400, currency: 'EUR', channel: 'Airbnb',
    });
  });

  it('ohne price_basis (Altbestand vor Migration 043, Hostex-Anfrage) → null', () => {
    expect(resolveGuestPrice({ ...base, price_basis: null, guest_total: null }, RATES)).toBeNull();
  });
});

describe('channelName', () => {
  it('kennt Airbnb in Guesty- und Hostex-Schreibweise', () => {
    expect(channelName('airbnb2')).toBe('Airbnb');
    expect(channelName('airbnb')).toBe('Airbnb');
    expect(channelName('booking_site')).toBe('Plattform');
    expect(channelName(null)).toBe('Plattform');
  });
});
