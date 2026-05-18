import { describe, it, expect } from 'vitest';
import { parseBookingInquiry } from './booking-inquiry.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 2,
  messageId: 'test-2@airbnb.com',
  subject: 'Anfrage von Lukas',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T10:00:00.000Z',
  htmlBody: `
    <html><body>
      <p>Reservierungscode: HMXYZ123</p>
      <p>Gast: Lukas Schmidt</p>
      <p>Check-in: 5. August 2026</p>
      <p>Check-out: 12. August 2026</p>
      <p>Gäste: 3</p>
    </body></html>
  `,
  textBody: `Reservierungscode: HMXYZ123
Gast: Lukas Schmidt
Check-in: 5. August 2026
Check-out: 12. August 2026
Gäste: 3`,
};

describe('parseBookingInquiry', () => {
  it('extracts reservation code and guest', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.reservationCode).toBe('HMXYZ123');
    expect(out?.guestName).toBe('Lukas Schmidt');
  });

  it('extracts dates', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.checkIn).toBe('2026-08-05');
    expect(out?.checkOut).toBe('2026-08-12');
  });

  it('type is "inquiry"', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.type).toBe('inquiry');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, htmlBody: '', textBody: 'no code' };
    expect(parseBookingInquiry(bad)).toBeNull();
  });
});
