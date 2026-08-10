/**
 * Shared HTML→flat-text extraction for Airbnb mail parsers.
 */
import * as cheerio from 'cheerio';
import type { RawMail } from '../../types/airbnb-mail.js';

export function getBodyText(raw: RawMail): string {
  if (raw.htmlBody && raw.htmlBody.length > 0) {
    const $ = cheerio.load(raw.htmlBody);
    $('style,script').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }
  if (raw.textBody) return raw.textBody.replace(/\s+/g, ' ').trim();
  return '';
}
