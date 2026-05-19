import { describe, it, expect } from 'vitest';
import { parseBookingInquiry } from './booking-inquiry.js';
import type { RawMail } from '../../types/airbnb-mail.js';

// Fixture shaped after a real Airbnb inquiry mail (Firenze, May 2026).
// Inquiries have NO reservation code and the guest name appears as initials.
const baseMail: RawMail = {
  uid: 2,
  messageId: '<test-2@airbnb.com>',
  subject: 'Anfrage für „Art-Filled Duplex Loft · Florence Design District" für den 23.–25. Mai 2026',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-10T10:00:00.000Z',
  htmlBody: '',
  textBody:
    'Antworte auf die Anfrage von M.C M.C Identität verifiziert · 1 Bewertung' +
    ' Berlin, Deutschland Hallo Micha, …' +
    ' Art-Filled Duplex Loft · Florence Design District Gesamte Unterkunft' +
    ' Check-in Sa., 23. Mai 15:00 Check-out Mo., 25. Mai 10:00' +
    ' Gäste 2 Erwachsene',
};

describe('parseBookingInquiry', () => {
  it('extracts guest name from "Antworte auf die Anfrage von"', () => {
    expect(parseBookingInquiry(baseMail)?.guestName).toBe('M.C');
  });

  it('synthesizes a stable reservationCode from messageId', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.reservationCode).toMatch(/^AIRBNB_INQ_/);
    // Same input → same code (stable).
    expect(out?.reservationCode).toBe(parseBookingInquiry(baseMail)?.reservationCode);
  });

  it('extracts dates with year inferred from receivedAt', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.checkIn).toBe('2026-05-23');
    expect(out?.checkOut).toBe('2026-05-25');
  });

  it('extracts numberOfGuests', () => {
    expect(parseBookingInquiry(baseMail)?.numberOfGuests).toBe(2);
  });

  it('type is "inquiry"', () => {
    expect(parseBookingInquiry(baseMail)?.type).toBe('inquiry');
  });

  it('returns null when guest line missing', () => {
    const bad: RawMail = { ...baseMail, textBody: 'Check-in Sa., 23. Mai 15:00 Check-out Mo., 25. Mai 10:00' };
    expect(parseBookingInquiry(bad)).toBeNull();
  });
});
