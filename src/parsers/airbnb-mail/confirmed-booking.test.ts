import { describe, it, expect } from 'vitest';
import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 1,
  messageId: 'test-1@airbnb.com',
  subject: 'Reservierung bestätigt: Anna Müller',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T09:00:00.000Z',
  htmlBody: `
    <html><body>
      <p>Reservierungscode: HMABCXYZ</p>
      <p>Gast: Anna Müller</p>
      <p>Check-in: 15. Juli 2026</p>
      <p>Check-out: 18. Juli 2026</p>
      <p>Gäste: 2</p>
      <table>
        <tr><td>Übernachtungen</td><td>270,00 €</td></tr>
        <tr><td>Reinigungsgebühr</td><td>30,00 €</td></tr>
        <tr><td>Service-Gebühr Airbnb</td><td>15,00 €</td></tr>
        <tr><td>Gesamt (du erhältst)</td><td>270,00 €</td></tr>
      </table>
    </body></html>
  `,
  textBody: `Reservierungscode: HMABCXYZ
Gast: Anna Müller
Check-in: 15. Juli 2026
Check-out: 18. Juli 2026
Gäste: 2
Übernachtungen: 270,00 €
Reinigungsgebühr: 30,00 €
Service-Gebühr Airbnb: 15,00 €
Gesamt (du erhältst): 270,00 €`,
};

describe('parseConfirmedBooking', () => {
  it('extracts reservation code', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.reservationCode).toBe('HMABCXYZ');
  });

  it('extracts guest name', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.guestName).toBe('Anna Müller');
  });

  it('extracts check-in/out dates as ISO YYYY-MM-DD', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.checkIn).toBe('2026-07-15');
    expect(out?.checkOut).toBe('2026-07-18');
  });

  it('extracts numberOfGuests', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.numberOfGuests).toBe(2);
  });

  it('extracts hostPayout from "du erhältst" line', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.hostPayout).toBe(270);
  });

  it('extracts cleaningFee', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.cleaningFee).toBe(30);
  });

  it('preserves messageId and receivedAt from RawMail', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.messageId).toBe('test-1@airbnb.com');
    expect(out?.receivedAt).toBe('2026-05-18T09:00:00.000Z');
  });

  it('returns null when no reservation code found', () => {
    const bad: RawMail = { ...baseMail, htmlBody: '', textBody: 'no code here' };
    expect(parseConfirmedBooking(bad)).toBeNull();
  });

  it('falls back to textBody if htmlBody is empty', () => {
    const noHtml: RawMail = { ...baseMail, htmlBody: '' };
    const out = parseConfirmedBooking(noHtml);
    expect(out?.reservationCode).toBe('HMABCXYZ');
    expect(out?.guestName).toBe('Anna Müller');
  });
});
