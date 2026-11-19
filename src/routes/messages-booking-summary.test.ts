// #1187: Formatierung der Anfrage-/Buchungsdaten (Kopfzeile + Listen-Badge).
import { describe, it, expect } from 'vitest';
import { renderBookingSummaryLine, renderBookingSummaryBadge, formatMoney, bookingKindLabel, renderCounterOfferLine } from './messages-booking-summary.js';
import type { ThreadBookingSummary } from '../services/booking-context.js';

const s = (over: Partial<ThreadBookingSummary> = {}): ThreadBookingSummary => ({
  kind: 'inquiry', status: 'inquiry', checkIn: '2027-12-31', checkOut: '2028-01-01', nights: 1,
  guestsCount: 1, adults: null, children: null, hostPayout: null, totalPrice: null, currency: null, platform: 'airbnb2', guestPrice: null, requestedAt: null, ...over,
});

describe('renderBookingSummaryLine', () => {
  it('Anfrage ohne Preis', () => {
    expect(renderBookingSummaryLine(s())).toContain('<strong>Anfrage</strong> · 31.12.2027–01.01.2028 · 1 Nacht · 1 Person (laut Anfrage) · Preis unbekannt');
  });
  it('Anfrage, nur Auszahlung bekannt: Gastpreis unbekannt (total_price wird bei Anfragen nie als Gastpreis gezeigt)', () => {
    const html = renderBookingSummaryLine(s({ hostPayout: 1234, totalPrice: 1234, currency: 'EUR' }));
    expect(html).toContain('<strong>Auszahlung 1.234 €</strong>');
    expect(html).toContain('Gastpreis unbekannt');
    expect(html).not.toContain('Gastpreis 1.234');
  });
  it('#1242 Anfrage mit berechnetem Gastbetrag (Fall Daniel): mit Steuer Hauptwert, ohne Steuer + Auszahlung klein', () => {
    const html = renderBookingSummaryLine(s({
      hostPayout: 3118.05, totalPrice: 3118.05, currency: 'EUR',
      guestPrice: { kind: 'estimated', inclTax: 3948.3, exclTax: 3690, currency: 'EUR', channel: 'Airbnb' },
    }));
    expect(html).toContain('<strong>Gastpreis laut Airbnb ca. 3.948,30 € inkl. Steuern</strong>');
    expect(html).toContain('<small style="opacity:.75">berechnet, ohne Steuern ca. 3.690 € · Auszahlung 3.118,05 €</small>');
  });
  it('#1242 Anfrage mit echtem Gastbetrag', () => {
    const html = renderBookingSummaryLine(s({
      hostPayout: 163.78, currency: 'EUR',
      guestPrice: { kind: 'actual', total: 191.53, currency: 'EUR', channel: 'Airbnb' },
    }));
    expect(html).toContain('<strong>Gastpreis laut Airbnb 191,53 € inkl. Steuern</strong>');
    expect(html).toContain('Auszahlung 163,78 €');
    expect(html).not.toContain('berechnet');
  });
  it('#1242 Anfrage mit Übernachtungspreis: ehrlich bezeichnet, Auszahlung Hauptwert', () => {
    const html = renderBookingSummaryLine(s({
      hostPayout: 4750, totalPrice: 4400, currency: 'EUR',
      guestPrice: { kind: 'accommodation', amount: 4400, currency: 'EUR', channel: 'Airbnb' },
    }));
    expect(html).toContain('<strong>Auszahlung 4.750 €</strong> <small style="opacity:.75">Übernachtungspreis 4.400 € (ohne Reinigung/Steuern)</small>');
  });
  it('#1242 Buchung bleibt wie bisher (Auszahlung + Gastpreis aus total_price)', () => {
    const html = renderBookingSummaryLine(s({ kind: 'reservation', status: 'confirmed', hostPayout: 1234, totalPrice: 1450, currency: 'EUR' }));
    expect(html).toContain('<strong>Auszahlung 1.234 €</strong> <small style="opacity:.75">Gastpreis 1.450 €</small>');
  });
  it('fehlende Personen und Daten: Striche', () => {
    const html = renderBookingSummaryLine(s({ guestsCount: null, checkIn: null, nights: null }));
    expect(html).toContain('–.–01.01.2028'.replace('–.–', '––'));
    expect(html).toContain('Personen –');
    expect(html).toContain('Nächte –');
  });
  it('ohne Verknüpfung', () => {
    expect(renderBookingSummaryLine(null)).toContain('keine Buchung/Anfrage verknüpft');
  });
  it('Buchung ohne Kinder: nur Erwachsene', () => {
    expect(renderBookingSummaryLine(s({ kind: 'reservation', status: 'confirmed', guestsCount: 2, adults: 2, children: 0 })))
      .toContain('2 Personen (2 Erw.)');
  });
});

describe('bookingKindLabel', () => {
  it('Status-Zusätze', () => {
    expect(bookingKindLabel(s())).toBe('Anfrage');
    expect(bookingKindLabel(s({ status: 'declined' }))).toBe('Anfrage (abgelehnt)');
    expect(bookingKindLabel(s({ kind: 'reservation', status: 'confirmed' }))).toBe('Buchung (bestätigt)');
    expect(bookingKindLabel(s({ kind: 'reservation', status: 'weird' }))).toBe('Buchung (weird)');
    // #1244: bestätigte Zeile aus inquiries (kind inquiry) ist eine Buchung; reserved = offene Request-to-Book bleibt Anfrage
    expect(bookingKindLabel(s({ status: 'confirmed' }))).toBe('Buchung (bestätigt)');
    expect(bookingKindLabel(s({ status: 'reserved' }))).toBe('Anfrage (reserviert)');
    expect(bookingKindLabel(s({ status: 'canceled' }))).toBe('Anfrage (storniert)');
    expect(bookingKindLabel(s({ status: 'expired' }))).toBe('Anfrage (abgelaufen)');
  });
});

describe('formatMoney', () => {
  it('ganze und gebrochene Beträge, unbekannte/fehlende Währung', () => {
    expect(formatMoney(1234, 'EUR')).toBe('1.234 €');
    expect(formatMoney(820.5, 'EUR')).toBe('820,50 €');
    expect(formatMoney(100, null)).toBe('100');
    expect(formatMoney(100, 'XX1')).toBe('100 XX1');
  });
});

describe('renderBookingSummaryBadge', () => {
  it('kompakt ohne Preis', () => {
    const html = renderBookingSummaryBadge(s({ hostPayout: 5, currency: 'EUR' }));
    expect(html).toContain('31.12.–01.01. · 1 P.');
    expect(html).not.toContain('€');
  });
  it('ohne Personen nur Zeitraum; ohne Daten/Verknüpfung leer', () => {
    expect(renderBookingSummaryBadge(s({ guestsCount: null }))).toContain('>31.12.–01.01.<');
    expect(renderBookingSummaryBadge(s({ checkIn: null, checkOut: null }))).toBe('');
    expect(renderBookingSummaryBadge(null)).toBe('');
  });
});

// Review-Gate #1187: Status und Währung stammen aus Fremd-APIs — nie roh ins HTML.
describe('HTML-Escaping', () => {
  const evil = '"><script>x</script>';
  it('Kopfzeile escaped unbekannten Status und Währungscode', () => {
    const html = renderBookingSummaryLine(s({ status: evil, hostPayout: 5, totalPrice: 6, currency: '<b>' }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('Badge escaped den Status im title-Attribut', () => {
    const html = renderBookingSummaryBadge(s({ status: evil }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('title="Anfrage ("');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('renderCounterOfferLine (#1243)', () => {
  it('leer ohne Notiz', () => {
    expect(renderCounterOfferLine(null)).toBe('');
    expect(renderCounterOfferLine('')).toBe('');
  });
  it('Absatz mit escaptem Text', () => {
    expect(renderCounterOfferLine('Betrag 2.600 € <b>')).toBe(
      '<p class="subtitle counter-offer" style="margin-top:-4px">Betrag 2.600 € &lt;b&gt;</p>',
    );
  });
});
