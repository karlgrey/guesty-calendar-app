// #1187: Formatierung der Anfrage-/Buchungsdaten (Kopfzeile + Listen-Badge).
import { describe, it, expect } from 'vitest';
import { renderBookingSummaryLine, renderBookingSummaryBadge, formatMoney, bookingKindLabel } from './messages-booking-summary.js';
import type { ThreadBookingSummary } from '../services/booking-context.js';

const s = (over: Partial<ThreadBookingSummary> = {}): ThreadBookingSummary => ({
  kind: 'inquiry', status: 'inquiry', checkIn: '2027-12-31', checkOut: '2028-01-01', nights: 1,
  guestsCount: 1, adults: null, children: null, hostPayout: null, totalPrice: null, currency: null, platform: 'airbnb2', ...over,
});

describe('renderBookingSummaryLine', () => {
  it('Anfrage ohne Preis', () => {
    expect(renderBookingSummaryLine(s())).toContain('<strong>Anfrage</strong> · 31.12.2027–01.01.2028 · 1 Nacht · 1 Person (laut Anfrage) · Preis unbekannt');
  });
  it('nur Auszahlung bekannt: Gastpreis –', () => {
    const html = renderBookingSummaryLine(s({ hostPayout: 1234, currency: 'EUR' }));
    expect(html).toContain('Auszahlung 1.234 €');
    expect(html).toContain('Gastpreis –');
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
