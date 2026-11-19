/**
 * #1242: Gast-Gesamtbetrag laut Airbnb (was der Gast in Airbnb zahlt bzw. sieht).
 *
 * Befund am echten Guesty-Payload (19.11.2026, Fall Daniel):
 * - Airbnb-ANFRAGEN liefern nur eine Position (AF, Herkunft CHANNEL):
 *   fareAccommodation = fareAccommodationAdjusted = subTotalPrice = hostPayout = Netto-Auszahlung
 *   des Gastgebers (Übernachtung + Reinigung − Host-Servicegebühr, ohne Steuer). Reinigung,
 *   Steuern und Host-Gebühr stehen auf 0. Der Gastbetrag ist dort NUR per Rückrechnung zu haben:
 *   ohne Steuer = Auszahlung / (1 − Host-Gebührensatz), mit Steuer = ohne Steuer + Steuer.
 *   Daniel: 3.118,05 / 0,845 = 3.690,00 (von Micha aus Airbnb belegt) · 1,07 = 3.948,30.
 * - BESTÄTIGTE Airbnb-Buchungen liefern die volle Aufstellung; Gastbetrag cent-genau
 *   = fareAccommodationAdjusted + fareCleaning + totalTaxes (13/13 geprüft).
 *
 * Die Sätze (Host-Gebühr, Steuer) kommen aus `airbnbGuestPrice` in data/properties.json, nie aus
 * dem Code. Gerechnet wird zur Anzeigezeit (Kontext, Thread-Kopf); die DB hält nur Plattform-Fakten
 * (`inquiries.guest_total`, `inquiries.price_basis`, Migration 043).
 */

export interface AirbnbGuestPriceRates {
  /** Host-Servicegebühr von Airbnb als Anteil, z. B. 0.155 */
  hostServiceFeeRate: number;
  /** Steuersatz auf Übernachtung + Reinigung als Anteil, z. B. 0.07 */
  taxRate: number;
}

/**
 * Herkunft des Preises einer inquiries-Zeile (geschrieben von den Sync-Mappern):
 * - 'guest_total':   guest_total ist der echte Gastbetrag inkl. Steuern laut Plattform
 * - 'net_payout':    die einzige Zahl ist die Netto-Auszahlung (Airbnb-Anfrage über Guesty)
 * - 'accommodation': total_price ist der Übernachtungspreis ohne Reinigung, Steuern, Gebühren
 * - null:            unbekannt (Altbestand vor Migration 043, Hostex-Anfrage, fehlende Felder)
 */
export type PriceBasis = 'guest_total' | 'net_payout' | 'accommodation';

export type GuestPrice =
  | { kind: 'actual'; total: number; currency: string | null; channel: string }
  | { kind: 'estimated'; inclTax: number; exclTax: number; currency: string | null; channel: string }
  | { kind: 'accommodation'; amount: number; currency: string | null; channel: string };

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Betrag → ganze Cent (gegen Float-Reste wie 0.1 + 0.2). */
const toCents = (x: number): number => Math.round(x * 100);

/** Satz → Basispunkte (0.155 → 1550), damit kaufmännisch in Ganzzahlen gerundet werden kann. */
const toBp = (rate: number): number => Math.round(rate * 10000);

/** Anteil eines Cent-Betrags, kaufmännisch gerundet (half up) — ganzzahlig, ohne Float-Fehler. */
function shareCents(cents: number, bp: number): number {
  return Math.floor((cents * bp + 5000) / 10000);
}

/** Anzahl Null-Stellen am Ende eines Cent-Betrags (379000 → 3, 17900 → 2, 29020 → 1). */
function trailingZeros(cents: number): number {
  let z = 0;
  let c = cents;
  while (z < 4 && c !== 0 && c % 10 === 0) {
    c /= 10;
    z++;
  }
  return z;
}

/**
 * Rückrechnung Netto-Auszahlung → Gastbetrag ohne/mit Steuer.
 *
 * Airbnb rundet die Host-Gebühr auf Cent; deshalb wird nicht nur Auszahlung / (1 − Satz)
 * gerundet, sondern unter den Cent-Beträgen in der Nähe derjenige gesucht, der vorwärts
 * gerechnet (Gastbetrag − gerundete Gebühr) genau die Auszahlung ergibt. Passen mehrere, gewinnt
 * der „rundeste" (ganze Euro vor Zehner-Cent — Airbnb-Preise und Reinigung sind meist glatt),
 * dann der nächste am rechnerischen Wert. Rest-Unschärfe: höchstens 1 Cent.
 * null bei ungültiger Auszahlung oder Gebührensatz außerhalb [0, 1).
 */
export function estimateAirbnbGuestTotal(
  netPayout: number,
  rates: AirbnbGuestPriceRates,
): { exclTax: number; tax: number; inclTax: number } | null {
  if (!Number.isFinite(netPayout) || netPayout <= 0) return null;
  const feeBp = toBp(rates.hostServiceFeeRate);
  const taxBp = toBp(rates.taxRate);
  if (feeBp < 0 || feeBp >= 10000 || taxBp < 0) return null;

  const netCents = toCents(netPayout);
  const exact = (netCents * 10000) / (10000 - feeBp);
  const center = Math.round(exact);

  let best: number | null = null;
  for (let c = center - 3; c <= center + 3; c++) {
    if (c <= 0 || c - shareCents(c, feeBp) !== netCents) continue;
    if (
      best === null ||
      trailingZeros(c) > trailingZeros(best) ||
      (trailingZeros(c) === trailingZeros(best) && Math.abs(c - exact) < Math.abs(best - exact))
    ) {
      best = c;
    }
  }
  const exclCents = best ?? center;
  const taxCents = shareCents(exclCents, taxBp);
  return { exclTax: exclCents / 100, tax: taxCents / 100, inclTax: (exclCents + taxCents) / 100 };
}

/**
 * Guesty-Reservierung (Liste ODER Einzelabruf) → guest_total + price_basis für die inquiries-Zeile.
 * Nutzt nur skalare money-Felder, die beide Wege liefern (Liste: `fields money.…`).
 * Fehlen die Aufschlüsselungsfelder, bleibt alles unbekannt (null) — lieber kein Preis als ein
 * falsch bezeichneter.
 */
export interface GuestyMoneySource {
  source?: unknown;
  integration?: { platform?: unknown } | null;
  money?: Record<string, unknown> | null;
}

export function classifyGuestyGuestPrice(
  r: GuestyMoneySource | null | undefined,
): { guest_total: number | null; price_basis: PriceBasis | null } {
  const unknown = { guest_total: null, price_basis: null };
  const m = r?.money;
  if (!m) return unknown;
  const fare = num(m.fareAccommodationAdjusted);
  if (fare == null || fare <= 0) return unknown;

  const isAirbnb = r?.source === 'airbnb2' || r?.integration?.platform === 'airbnb2';
  if (!isAirbnb) return { guest_total: null, price_basis: 'accommodation' };

  const cleaning = num(m.fareCleaning);
  const taxes = num(m.totalTaxes);
  const hostFee = num(m.hostServiceFee);
  const payout = num(m.hostPayout);
  if (cleaning == null || taxes == null || hostFee == null) return unknown;

  if (hostFee > 0) {
    // Volle Aufstellung vom Kanal (bestätigte Buchung)
    return { guest_total: (toCents(fare) + toCents(cleaning) + toCents(taxes)) / 100, price_basis: 'guest_total' };
  }
  if (cleaning === 0 && taxes === 0 && payout != null && toCents(payout) === toCents(fare)) {
    // Nur die Netto-Position (Airbnb-Anfrage seit 10/2026)
    return { guest_total: null, price_basis: 'net_payout' };
  }
  // Guesty-eigene Aufstellung ohne Kanal-Gebühr (ältere Anfragen): fare = Übernachtung
  return { guest_total: null, price_basis: 'accommodation' };
}

/** Plattform-Name für Texte: Airbnb (Guesty `airbnb2`, Hostex `airbnb`), sonst „Plattform". */
export function channelName(source: string | null | undefined): string {
  const s = (source ?? '').toLowerCase();
  return s === 'airbnb2' || s === 'airbnb' ? 'Airbnb' : 'Plattform';
}

export interface GuestPriceRow {
  source: string | null;
  currency: string | null;
  total_price: number | null;
  host_payout: number | null;
  guest_total: number | null;
  price_basis: string | null;
}

/**
 * Gastbetrag einer inquiries-Zeile zur Anzeige (Entwurfs-Kontext, Thread-Kopf).
 * null = kein ehrlich benennbarer Gastpreis (dann gar keinen nennen).
 */
export function resolveGuestPrice(row: GuestPriceRow, rates: AirbnbGuestPriceRates | undefined): GuestPrice | null {
  const channel = channelName(row.source);
  const currency = row.currency;
  switch (row.price_basis) {
    case 'guest_total':
      return row.guest_total != null && row.guest_total > 0
        ? { kind: 'actual', total: row.guest_total, currency, channel }
        : null;
    case 'net_payout': {
      if (!rates || row.host_payout == null) return null;
      const e = estimateAirbnbGuestTotal(row.host_payout, rates);
      return e ? { kind: 'estimated', inclTax: e.inclTax, exclTax: e.exclTax, currency, channel } : null;
    }
    case 'accommodation':
      return row.total_price != null && row.total_price > 0
        ? { kind: 'accommodation', amount: row.total_price, currency, channel }
        : null;
    default:
      return null;
  }
}
