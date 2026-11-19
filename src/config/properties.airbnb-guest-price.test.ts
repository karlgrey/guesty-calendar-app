// #1242: Sätze für den berechneten Gastbetrag bei Airbnb-Anfragen (Top-Level-Block in properties.json)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAirbnbGuestPriceConfig } from './properties.js';

describe('parseAirbnbGuestPriceConfig', () => {
  it('parst einen gültigen Block', () => {
    expect(parseAirbnbGuestPriceConfig({ hostServiceFeeRate: 0.155, taxRate: 0.07 })).toEqual({ hostServiceFeeRate: 0.155, taxRate: 0.07 });
  });

  it('fehlender Block → undefined', () => {
    expect(parseAirbnbGuestPriceConfig(undefined)).toBeUndefined();
  });

  it('lehnt Sätze außerhalb des Bereichs ab (Prozent statt Anteil, Gebühr 100 %)', () => {
    expect(() => parseAirbnbGuestPriceConfig({ hostServiceFeeRate: 15.5, taxRate: 0.07 })).toThrow();
    expect(() => parseAirbnbGuestPriceConfig({ hostServiceFeeRate: 1, taxRate: 0.07 })).toThrow();
    expect(() => parseAirbnbGuestPriceConfig({ hostServiceFeeRate: 0.155, taxRate: 7 })).toThrow();
  });

  it('data/properties.json trägt die Sätze 15,5 % / 7 % (Entscheidung Micha 19.11.2026)', () => {
    const raw = JSON.parse(readFileSync(new URL('../../data/properties.json', import.meta.url), 'utf-8'));
    expect(parseAirbnbGuestPriceConfig(raw.airbnbGuestPrice)).toEqual({ hostServiceFeeRate: 0.155, taxRate: 0.07 });
  });
});
