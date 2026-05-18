import { describe, it, expect } from 'vitest';
import { parseModification } from './modification.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 4,
  messageId: 'test-4@airbnb.com',
  subject: 'Datum geändert: HMMOD1',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T12:00:00.000Z',
  htmlBody: '',
  textBody: `Reservierungscode: HMMOD1
Gast: Tom Weber
Neue Daten:
Check-in: 1. September 2026
Check-out: 5. September 2026
Gäste: 4`,
};

describe('parseModification', () => {
  it('extracts reservation code', () => {
    const out = parseModification(baseMail);
    expect(out?.reservationCode).toBe('HMMOD1');
  });

  it('extracts new dates', () => {
    const out = parseModification(baseMail);
    expect(out?.checkIn).toBe('2026-09-01');
    expect(out?.checkOut).toBe('2026-09-05');
  });

  it('type is "modification"', () => {
    const out = parseModification(baseMail);
    expect(out?.type).toBe('modification');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, textBody: 'no code' };
    expect(parseModification(bad)).toBeNull();
  });
});
