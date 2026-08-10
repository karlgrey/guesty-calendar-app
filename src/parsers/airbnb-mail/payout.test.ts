import { describe, it, expect } from 'vitest';
import { parsePayoutMail } from './payout.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const topUpMail: RawMail = {
  uid: 10, messageId: 'payout-1@airbnb.com',
  subject: 'Wir haben eine Auszahlung in Höhe von 72,48 € EUR gesendet',
  fromAddress: 'express@airbnb.com',
  receivedAt: '2026-08-03T13:52:27.000Z',
  htmlBody: '',
  textBody:
    '72,48 € EUR wurden heute versendet Deine Auszahlung wurde am 3. August versendet' +
    ' Bankkonto Christian Henschel, IBAN 7706 (EUR) ID des Airbnb-Kontos 1678835943572371700 Details' +
    ' Egbert Witteveen -31,50 € EUR Steuereinbehalt bei Einkünften in Italien • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Egbert Witteveen -18,35 € EUR Auszahlung an Co-Gastgeber:innen • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Egbert Witteveen 122,33 € EUR Unterkunft • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Gesamtbetrag der Auszahlung: 72,48 € EUR',
};

describe('parsePayoutMail', () => {
  it('parses total from subject and payout date from receivedAt', () => {
    const out = parsePayoutMail(topUpMail);
    expect(out?.totalAmount).toBeCloseTo(72.48, 2);
    expect(out?.payoutDate).toBe('2026-08-03');
  });

  it('parses all line items with code, listing, stay dates and signed amounts', () => {
    const out = parsePayoutMail(topUpMail);
    expect(out?.items).toHaveLength(3);
    expect(out?.items[0]).toEqual({
      amount: -31.5,
      category: 'Steuereinbehalt bei Einkünften in Italien',
      stayStart: '2026-08-02',
      stayEnd: '2026-08-08',
      listingId: '1678837365136764301',
      reservationCode: 'HME9WZFQTY',
    });
    const sum = out!.items.reduce((a, i) => a + i.amount, 0);
    expect(sum).toBeCloseTo(72.48, 2);
  });

  it('parses thousands amounts ("1.068,00")', () => {
    const mail: RawMail = {
      ...topUpMail,
      subject: 'Wir haben eine Auszahlung in Höhe von 1.068,00 € EUR gesendet',
    };
    expect(parsePayoutMail(mail)?.totalAmount).toBeCloseTo(1068, 2);
  });

  it('returns null when subject does not match', () => {
    expect(parsePayoutMail({ ...topUpMail, subject: 'Buchung aktualisiert' })).toBeNull();
  });
});
