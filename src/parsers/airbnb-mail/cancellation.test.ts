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

  it('returns null when reservation code missing from both body and subject', () => {
    const bad: RawMail = {
      ...baseMail,
      subject: 'Reservierung storniert',
      textBody: 'cancellation but no code',
    };
    expect(parseCancellation(bad)).toBeNull();
  });

  it('parses cancellation with only reservation code (no guest, no dates)', () => {
    const minimal: RawMail = {
      uid: 99,
      messageId: 'minimal@airbnb.com',
      subject: 'Reservierung storniert: HMMINCANCEL',
      fromAddress: 'automated@airbnb.com',
      receivedAt: '2026-05-18T13:00:00.000Z',
      htmlBody: '',
      textBody: 'Diese Reservierung wurde storniert.\nReservierungscode: HMMINCANCEL',
    };
    const out = parseCancellation(minimal);
    expect(out?.reservationCode).toBe('HMMINCANCEL');
    expect(out?.type).toBe('cancellation');
  });

  it('extracts reservation code from subject when body has no code', () => {
    const subjectOnly: RawMail = {
      uid: 100,
      messageId: 'subjectonly@airbnb.com',
      subject: 'Reservierung storniert: HMSUBJ123',
      fromAddress: 'automated@airbnb.com',
      receivedAt: '2026-05-18T13:00:00.000Z',
      htmlBody: '',
      textBody: 'Diese Reservierung wurde storniert.',
    };
    const out = parseCancellation(subjectOnly);
    expect(out?.reservationCode).toBe('HMSUBJ123');
  });
});
