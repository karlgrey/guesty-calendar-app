import { describe, it, expect } from 'vitest';
import { parseCancellation } from './cancellation.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 3,
  messageId: 'test-3@airbnb.com',
  subject: 'Reservierung storniert: HMSTORNO1',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T11:00:00.000Z',
  htmlBody: '',
  textBody: `Reservierungscode: HMSTORNO1
Gast: Sandra Klein
Check-in: 20. Juli 2026
Check-out: 22. Juli 2026
Diese Reservierung wurde storniert.`,
};

describe('parseCancellation', () => {
  it('extracts reservation code', () => {
    const out = parseCancellation(baseMail);
    expect(out?.reservationCode).toBe('HMSTORNO1');
  });

  it('extracts guest name and dates if present', () => {
    const out = parseCancellation(baseMail);
    expect(out?.guestName).toBe('Sandra Klein');
    expect(out?.checkIn).toBe('2026-07-20');
    expect(out?.checkOut).toBe('2026-07-22');
  });

  it('type is "cancellation"', () => {
    const out = parseCancellation(baseMail);
    expect(out?.type).toBe('cancellation');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, textBody: 'cancellation but no code' };
    expect(parseCancellation(bad)).toBeNull();
  });
});
