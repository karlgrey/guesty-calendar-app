import { describe, it, expect } from 'vitest';
import { getBodyText } from './body-text.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const raw = (over: Partial<RawMail>): RawMail => ({
  uid: 1, messageId: 'x', subject: 's', fromAddress: 'f',
  receivedAt: '2026-08-03T11:28:28.000Z', htmlBody: '', textBody: '', ...over,
});

describe('getBodyText', () => {
  it('strips tags and styles, collapses whitespace', () => {
    const text = getBodyText(raw({
      htmlBody: '<html><head><style>.x{color:red}</style></head><body><p>425,40&nbsp;€  EUR</p>\n<div>wurden   versendet</div></body></html>',
    }));
    expect(text).toBe('425,40 € EUR wurden versendet');
  });

  it('falls back to textBody', () => {
    expect(getBodyText(raw({ textBody: ' a  b ' }))).toBe('a b');
  });
});
