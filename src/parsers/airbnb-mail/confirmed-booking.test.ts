import { describe, it, expect } from 'vitest';
import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail } from '../../types/airbnb-mail.js';

// Fixture shaped after a real Airbnb confirmed-booking mail (Firenze, May 2026).
// After HTML→text + whitespace collapse, the body reads as one flat string.
const baseMail: RawMail = {
  uid: 1,
  messageId: 'test-1@airbnb.com',
  subject: 'Buchung bestätigt – Anna Müller kommt am 17. Mai an',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-10T09:00:00.000Z',
  htmlBody: '',
  textBody:
    'Neue Buchung bestätigt: Anna kommt am 17. Mai an' +
    ' Anna Müller Identität verifiziert · 8 Bewertungen' +
    ' Urban Luxury Loft - Florence Interior Design Hub Gesamte Unterkunft' +
    ' Check-in So., 17. Mai 15:00 Check-out Fr., 22. Mai 10:00' +
    ' Gäste 1 Erwachsene:r' +
    ' Bestätigungs-Code HMFAEM5CJH' +
    ' 232,00 € x 5 Nächte 1.160,00 € Reinigungsgebühr 120,00 €' +
    ' Servicegebühr für Gäste 0,00 € Belegungssteuern 30,00 €' +
    ' Gesamt (EUR) 1.310,00 €' +
    ' Auszahlung an Gastgeber:in Gebühr für 5 Nächte 1.160,00 €' +
    ' Reinigungsgebühr 120,00 € Servicegebühr für Gastgeber:innen (15.5 % + MwSt.) -236,10 €' +
    ' Du verdienst 1.043,90 €',
};

describe('parseConfirmedBooking', () => {
  it('extracts reservation code from "Bestätigungs-Code"', () => {
    expect(parseConfirmedBooking(baseMail)?.reservationCode).toBe('HMFAEM5CJH');
  });

  it('extracts full guest name from Subject', () => {
    expect(parseConfirmedBooking(baseMail)?.guestName).toBe('Anna Müller');
  });

  it('extracts check-in/out as ISO YYYY-MM-DD (year inferred from receivedAt)', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.checkIn).toBe('2026-05-17');
    expect(out?.checkOut).toBe('2026-05-22');
  });

  it('handles abbreviated month "Aug."', () => {
    const aug: RawMail = {
      ...baseMail,
      subject: 'Buchung bestätigt – John Charlton kommt am 9. Aug. an',
      textBody:
        baseMail.textBody
          .replace('Check-in So., 17. Mai 15:00', 'Check-in So., 9. Aug. 15:00')
          .replace('Check-out Fr., 22. Mai 10:00', 'Check-out Fr., 14. Aug. 10:00'),
    };
    const out = parseConfirmedBooking(aug);
    expect(out?.checkIn).toBe('2026-08-09');
    expect(out?.checkOut).toBe('2026-08-14');
  });

  it('infers next year when arrival month is before receivedAt month', () => {
    const earlyNextYear: RawMail = {
      ...baseMail,
      subject: 'Buchung bestätigt – Maria Rossi kommt am 5. Februar an',
      receivedAt: '2026-12-15T09:00:00.000Z',
      textBody:
        baseMail.textBody
          .replace('Check-in So., 17. Mai 15:00', 'Check-in Do., 5. Februar 15:00')
          .replace('Check-out Fr., 22. Mai 10:00', 'Check-out Mo., 9. Februar 10:00'),
    };
    const out = parseConfirmedBooking(earlyNextYear);
    expect(out?.checkIn).toBe('2027-02-05');
    expect(out?.checkOut).toBe('2027-02-09');
  });

  it('extracts numberOfGuests from "Gäste N Erwachsene"', () => {
    expect(parseConfirmedBooking(baseMail)?.numberOfGuests).toBe(1);
  });

  it('extracts cleaningFee, hostPayout, totalPrice (German number format)', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.cleaningFee).toBe(120);
    expect(out?.hostPayout).toBe(1043.9);
    expect(out?.totalPrice).toBe(1310);
  });

  it('returns null when Subject does not match', () => {
    const bad: RawMail = { ...baseMail, subject: 'Newsletter Mai' };
    expect(parseConfirmedBooking(bad)).toBeNull();
  });

  it('returns null when reservation code missing in body', () => {
    const bad: RawMail = { ...baseMail, textBody: 'Check-in So., 17. Mai 15:00 Check-out Fr., 22. Mai 10:00' };
    expect(parseConfirmedBooking(bad)).toBeNull();
  });

  it('preserves messageId and receivedAt', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.messageId).toBe('test-1@airbnb.com');
    expect(out?.receivedAt).toBe('2026-05-10T09:00:00.000Z');
  });
});
