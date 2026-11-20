/**
 * #1284: Kalender-Report "Nächste Gäste" je Objekt. sendEmail ist IMMER gemockt (kein echter Versand).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ default: loggerMock }));

type Res = Record<string, unknown>;
let reservations: Res[] = [];
const getReservationsByPeriodMock = vi.fn((_id: string, _days: number, _mode: string) => reservations);
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationsByPeriod: (...a: [string, number, string]) => getReservationsByPeriodMock(...a),
}));
const getActiveRecipientEmailsMock = vi.fn<(type: string, slug?: string) => string[]>();
vi.mock('../repositories/report-recipient-repository.js', () => ({
  getActiveRecipientEmails: (...a: [string, string?]) => getActiveRecipientEmailsMock(...a),
}));
const sendEmailMock = vi.fn(async (_o: unknown) => true);
vi.mock('../services/email-service.js', () => ({ sendEmail: (o: unknown) => sendEmailMock(o) }));

const prop = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug, name, provider: 'guesty', guestyPropertyId: `id-${slug}`,
  timezone: 'Europe/Berlin', currency: 'EUR', bookingRecipientEmail: 'b@e.com', bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 }, ...extra,
});
let allProps: ReturnType<typeof prop>[];
vi.mock('../config/properties.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, getAllProperties: () => allProps };
});

import { buildCalendarReportModel, sendCalendarWeeklyEmails, sendCalendarWeeklyEmailForProperty, CALENDAR_BOOKINGS_LIMIT } from './calendar-email.js';
import { generateCalendarEmail, channelLabel, firstNameOf } from '../services/calendar-email-templates.js';
import { WEEKLY_SUMMARY_STYLES } from '../services/email-templates.js';

// Montag 23.11.2026 06:00 Berlin, KW 48
const NOW = new Date('2026-11-23T05:00:00Z');
const stay = (id: string, ci: string, co: string, extra: Res = {}): Res => ({
  reservation_id: id, check_in: ci, check_out: co, status: 'confirmed', nights_count: 2,
  guest_name: 'Anna Schmidt', guests_count: 3, source: 'airbnb2', platform: null,
  host_payout: 1234.56, total_price: 4321, currency: 'EUR', confirmation_code: 'HMXYZ98765',
  guest_email: 'anna.schmidt@example.com', guest_phone: '+491701234567', ...extra,
});
const sentMails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string[]; subject: string; html: string; text: string });

beforeEach(() => {
  vi.clearAllMocks();
  reservations = [stay('r1', '2026-11-25', '2026-11-27')];
  allProps = [prop('farmhouse', 'Farmhouse'), prop('rh40', 'RH40')];
  getActiveRecipientEmailsMock.mockImplementation((_t, slug) => (slug === 'farmhouse' ? ['f@x.de'] : ['r@x.de']));
});

describe('je Objekt eine Mail', () => {
  it('jedes Objekt geht an die eigenen Abonnenten, Betreff mit Objektname und KW 48', async () => {
    const results = await sendCalendarWeeklyEmails(NOW);
    expect(results.map((r) => [r.propertySlug, r.sent])).toEqual([['farmhouse', true], ['rh40', true]]);
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('calendar-weekly', 'farmhouse');
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('calendar-weekly', 'rh40');
    const mails = sentMails();
    expect(mails).toHaveLength(2);
    expect(mails[0].to).toEqual(['f@x.de']);
    expect(mails[0].subject).toBe('📅 Nächste Gäste · Farmhouse · KW 48');
    expect(mails[1].to).toEqual(['r@x.de']);
    expect(mails[1].subject).toContain('RH40');
    expect(mails[1].subject).toContain('KW 48');
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ propertySlug: 'farmhouse', recipientCount: 1, bookings: 1 }),
      expect.stringContaining('Kalender-Report gesendet'),
    );
  });

  it('Buchungen kommen wie im Weekly Summary (365 Tage, future)', async () => {
    await sendCalendarWeeklyEmailForProperty(allProps[0] as never, NOW);
    expect(getReservationsByPeriodMock).toHaveBeenCalledWith('id-farmhouse', 365, 'future');
  });

  it('Objekt ohne Abo wird übersprungen, die anderen bekommen ihre Mail', async () => {
    getActiveRecipientEmailsMock.mockImplementation((_t, slug) => (slug === 'farmhouse' ? [] : ['r@x.de']));
    const results = await sendCalendarWeeklyEmails(NOW);
    expect(results[0]).toMatchObject({ propertySlug: 'farmhouse', success: true, sent: false, error: 'No recipients' });
    expect(results[1]).toMatchObject({ propertySlug: 'rh40', sent: true });
    expect(sentMails()).toHaveLength(1);
    expect(sentMails()[0].to).toEqual(['r@x.de']);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ propertySlug: 'farmhouse' }),
      expect.stringContaining('kein aktiver Empfänger'),
    );
  });

  it('Florenz ist ab 24.11. nicht mehr dabei', async () => {
    allProps = [prop('firenze-loft', 'Florenz', { reportingUntil: '2026-11-23' })];
    getActiveRecipientEmailsMock.mockReturnValue(['fl@x.de']);
    expect((await sendCalendarWeeklyEmails(NOW))[0].sent).toBe(true);
    expect(sentMails()).toHaveLength(1);
    for (const d of ['2026-11-24T05:00:00Z', '2026-11-30T05:00:00Z']) {
      const [r] = await sendCalendarWeeklyEmails(new Date(d));
      expect(r).toMatchObject({ success: true, sent: false, error: 'Not in reporting' });
    }
    expect(sentMails()).toHaveLength(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ propertySlug: 'firenze-loft' }),
      expect.stringContaining('aus dem Reporting'),
    );
  });

  it('sendEmail false -> success:false, Fehler geloggt', async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    const r = await sendCalendarWeeklyEmailForProperty(allProps[0] as never, NOW);
    expect(r).toMatchObject({ success: false, sent: false });
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ propertySlug: 'farmhouse' }), expect.any(String));
  });

  it('Exception im Versand -> success:false statt Wurf', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    const r = await sendCalendarWeeklyEmailForProperty(allProps[0] as never, NOW);
    expect(r).toMatchObject({ success: false, sent: false, error: 'smtp down' });
  });
});

describe('Inhalt', () => {
  it('kein Preis, keine Kontaktdaten, kein Code, nur der Vorname', async () => {
    await sendCalendarWeeklyEmailForProperty(allProps[0] as never, NOW);
    const mail = sentMails()[0];
    for (const out of [mail.html, mail.text]) {
      for (const bad of ['1234', '1.234', '4321', '4.321', '€', 'EUR', 'Price', 'Schmidt', 'example.com', '@', '+4917', 'HMXYZ98765']) {
        expect(out).not.toContain(bad);
      }
      expect(out).toContain('Anna');
    }
  });

  it('höchstens fünf Buchungen, Reihenfolge wie geliefert', () => {
    reservations = Array.from({ length: 7 }, (_, i) => stay(`r${i}`, `2026-12-0${i + 1}`, `2026-12-0${i + 2}`, { guest_name: `Gast${i}` }));
    expect(CALENDAR_BOOKINGS_LIMIT).toBe(5);
    const m = buildCalendarReportModel(allProps[0] as never, NOW);
    expect(m.bookings.map((b) => b.firstName)).toEqual(['Gast0', 'Gast1', 'Gast2', 'Gast3', 'Gast4']);
    const { html, text } = generateCalendarEmail(m);
    expect(html.match(/<span class="status-badge/g)).toHaveLength(5);
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
    expect(html.indexOf('Gast0')).toBeLessThan(html.indexOf('Gast4'));
  });

  it('Modell: KW, Name, Zeilenfelder mit Defaults', () => {
    reservations = [stay('r', '2026-11-25', '2026-11-27', { nights_count: null, guests_count: null, source: null, guest_name: null })];
    const m = buildCalendarReportModel(allProps[0] as never, NOW);
    expect(m).toMatchObject({ propertySlug: 'farmhouse', propertyName: 'Farmhouse', weekNumber: 48 });
    expect(m.bookings[0]).toEqual({ firstName: 'Gast', channel: '–', checkIn: '2026-11-25', checkOut: '2026-11-27', nights: 0, guests: 0, status: 'confirmed' });
  });

  it('ohne kommende Buchung: Leertext in HTML und Text', () => {
    reservations = [];
    const { html, text } = generateCalendarEmail(buildCalendarReportModel(allProps[0] as never, NOW));
    expect(html).toContain('<div class="no-data">No upcoming bookings</div>');
    expect(text).toContain('No upcoming bookings');
  });

  it('Layout wie Weekly Summary: Style-Block, Footer, Spalten ohne Price', () => {
    const { html, text } = generateCalendarEmail(buildCalendarReportModel(allProps[0] as never, NOW));
    expect(html).toContain(WEEKLY_SUMMARY_STYLES);
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<h1>📅 Nächste Gäste</h1>');
    expect(html).toContain('<strong>Farmhouse</strong> · KW 48');
    expect(html).toContain('This is an automated weekly summary generated by Guesty Calendar App');
    expect(html).toContain('📅 Next 5 Upcoming Bookings');
    for (const col of ['Guest', 'Check-in', 'Check-out', 'Nights', 'Guests', 'Status']) expect(html).toContain(`<th>${col}</th>`);
    expect(html).not.toContain('<th>Price</th>');
    expect(html).toContain('<small style="color: #7f8c8d;">Airbnb</small>');
    expect(html).toContain('status-badge status-confirmed');
    expect(text.startsWith('Nächste Gäste - Farmhouse - KW 48\n' + '='.repeat(60))).toBe(true);
    expect(text).toContain('NEXT 5 UPCOMING BOOKINGS');
    expect(text).toContain('- Anna (Airbnb) | ');
    expect(text).toContain('| 2 nights | 3 guests | confirmed');
    expect(text.endsWith('---\nThis is an automated weekly summary.')).toBe(true);
  });

  it('escaped datenstämmige Strings', () => {
    reservations = [stay('r', '2026-11-25', '2026-11-27', { guest_name: '<b>Eve</b> X', source: 'a<i>' })];
    allProps = [prop('farmhouse', 'Farm <house>')];
    const { html } = generateCalendarEmail(buildCalendarReportModel(allProps[0] as never, NOW));
    expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(html).toContain('a&lt;i&gt;');
    expect(html).toContain('Farm &lt;house&gt;');
    expect(html).not.toContain('<b>Eve');
  });

  it('Kanal-Mapping und Vorname', () => {
    expect(channelLabel('airbnb2')).toBe('Airbnb');
    expect(channelLabel('Booking')).toBe('Booking.com');
    expect(channelLabel('website')).toBe('Direkt');
    expect(channelLabel('vrbo')).toBe('vrbo');
    expect(channelLabel(null, null)).toBe('–');
    expect(firstNameOf('  Anna Maria Schmidt')).toBe('Anna');
    expect(firstNameOf('')).toBe('Gast');
  });
});
