/**
 * #1223: Kalender-Report "Nächste Gäste". sendEmail ist IMMER gemockt (kein echter Versand).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Res = Record<string, unknown>;
let reservations: Res[] = [];
let availability: Array<{ date: string; status: string; block_type: string | null }> = [];
vi.mock('../repositories/reservation-repository.js', () => ({
  ACTIVE_RESERVATION_STATUSES: ['confirmed', 'reserved'],
  // echte Überlappungslogik des Repos nachgebildet
  getReservationsInRange: (_id: string, start: string, end: string) =>
    reservations.filter((r) => String(r.check_in).slice(0, 10) <= end && String(r.check_out).slice(0, 10) >= start),
}));
vi.mock('../repositories/availability-repository.js', () => ({
  getAvailability: (_id: string, start: string, end: string) => availability.filter((a) => a.date >= start && a.date <= end),
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

import { buildCalendarReportModel, sendCalendarWeeklyEmail } from './calendar-email.js';
import { generateCalendarEmail } from '../services/calendar-email-templates.js';

// Montag 23.11.2026 06:00 Berlin
const NOW = new Date('2026-11-23T05:00:00Z');
const stay = (id: string, ci: string, co: string, extra: Res = {}): Res => ({
  reservation_id: id, check_in: ci, check_out: co, status: 'confirmed',
  guest_name: 'Anna Schmidt', guests_count: 3, source: 'airbnb2', platform: null,
  host_payout: 1234.56, total_price: 1234.56, currency: 'EUR',
  guest_email: 'anna.schmidt@example.com', guest_phone: '+491701234567', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  reservations = [];
  availability = [];
  allProps = [prop('farmhouse', 'Farmhouse'), prop('firenze-loft', 'Florenz', { reportingUntil: '2026-11-23' })];
  getActiveRecipientEmailsMock.mockReturnValue(['a@x.de']);
});

describe('Fenster heute .. heute+14', () => {
  it('check_in heute+14 drin, heute+15 nicht; laufender Aufenthalt (check_out heute) drin; check_out gestern nicht', () => {
    reservations = [
      stay('in14', '2026-12-07', '2026-12-09'),
      stay('in15', '2026-12-08', '2026-12-10'),
      stay('running', '2026-11-20', '2026-11-23'),
      stay('gone', '2026-11-18', '2026-11-22'),
    ];
    const m = buildCalendarReportModel([allProps[0]] as never, NOW);
    expect(m.windowStart).toBe('2026-11-23');
    expect(m.windowEnd).toBe('2026-12-07');
    const checkIns = m.properties[0].entries.map((e: any) => e.checkIn);
    expect(checkIns).toEqual(['2026-11-20', '2026-12-07']);
  });

  it('stornierte Reservierung nicht drin', () => {
    reservations = [stay('c', '2026-11-25', '2026-11-27', { status: 'canceled' }), stay('ok', '2026-11-26', '2026-11-28')];
    const m = buildCalendarReportModel([allProps[0]] as never, NOW);
    expect(m.properties[0].entries).toHaveLength(1);
  });

  it('Block-Zeile wird zusammengefasst, beschnitten und chronologisch einsortiert', () => {
    reservations = [stay('r', '2026-11-30', '2026-12-02')];
    availability = [
      { date: '2026-11-25', status: 'blocked', block_type: 'owner' },
      { date: '2026-11-26', status: 'blocked', block_type: 'manual' },
      { date: '2026-11-27', status: 'booked', block_type: null },
    ];
    const m = buildCalendarReportModel([allProps[0]] as never, NOW);
    expect(m.properties[0].entries).toEqual([
      { kind: 'block', from: '2026-11-25', to: '2026-11-26' },
      expect.objectContaining({ kind: 'stay', checkIn: '2026-11-30' }),
    ]);
    const { html, text } = generateCalendarEmail(m);
    expect(html).toContain('Mi 25.11. – Do 26.11. · geblockt');
    expect(text).toContain('geblockt');
  });

  it('Hold (reserved, Nächte lokal blocked) steht nur als Aufenthalt da, nicht zusätzlich als geblockt', () => {
    reservations = [stay('hold', '2026-11-25', '2026-11-27', { status: 'reserved' })];
    availability = [
      { date: '2026-11-25', status: 'blocked', block_type: null },
      { date: '2026-11-26', status: 'blocked', block_type: null },
      { date: '2026-11-27', status: 'blocked', block_type: null }, // Abreisetag: echter Block danach bleibt
    ];
    const m = buildCalendarReportModel([allProps[0]] as never, NOW);
    expect(m.properties[0].entries).toEqual([
      expect.objectContaining({ kind: 'stay', checkIn: '2026-11-25', checkOut: '2026-11-27' }),
      { kind: 'block', from: '2026-11-27', to: '2026-11-27' },
    ]);
  });
});

describe('Rendering', () => {
  it('Vorname, Personenzahl, Kanal; leeres Objekt zeigt Leer-Text', () => {
    reservations = [stay('r', '2026-11-25', '2026-11-27'), stay('r2', '2026-11-26', '2026-11-28', { guest_name: null, guests_count: null, source: null })];
    const { html, text } = generateCalendarEmail(buildCalendarReportModel([allProps[0]] as never, NOW));
    expect(html).toContain('Anna');
    expect(html).toContain('3 P');
    expect(html).toContain('Airbnb');
    expect(html).toContain('Gast');
    expect(html).toContain('– P');
    expect(text).toContain('Mi 25.11. → Fr 27.11. · Anna · 3 P · Airbnb');

    const empty = generateCalendarEmail({ ...buildCalendarReportModel([allProps[0]] as never, NOW), properties: [{ slug: 'x', name: 'Leer <b>', entries: [] }] });
    expect(empty.html).toContain('keine Gäste in den nächsten 14 Tagen');
    expect(empty.html).toContain('Leer &lt;b&gt;');
    expect(empty.text).toContain('keine Gäste in den nächsten 14 Tagen');
  });

  it('Kanal-Mapping', async () => {
    const { channelLabel } = await import('../services/calendar-email-templates.js');
    expect(channelLabel('airbnb')).toBe('Airbnb');
    expect(channelLabel('airbnb2')).toBe('Airbnb');
    expect(channelLabel('booking.com')).toBe('Booking.com');
    expect(channelLabel('Booking')).toBe('Booking.com');
    expect(channelLabel('website')).toBe('Direkt');
    expect(channelLabel('manual')).toBe('Direkt');
    expect(channelLabel('vrbo')).toBe('vrbo');
    expect(channelLabel(null, null)).toBe('–');
  });

  it('keine Beträge und keine Kontaktdaten in HTML und Text', async () => {
    reservations = [stay('r', '2026-11-25', '2026-11-27')];
    await sendCalendarWeeklyEmail(NOW);
    const mail = sendEmailMock.mock.calls[0][0] as { html: string; text: string };
    for (const out of [mail.html, mail.text]) {
      expect(out).not.toContain('€');
      expect(out).not.toContain('EUR');
      expect(out).not.toContain('1234');
      expect(out).not.toContain('Schmidt');
      expect(out).not.toContain('example.com');
      expect(out).not.toContain('@');
      expect(out).not.toContain('+4917');
    }
  });
});

describe('sendCalendarWeeklyEmail', () => {
  it('Empfänger calendar-weekly, Betreff mit KW und Zeitraum', async () => {
    const r = await sendCalendarWeeklyEmail(NOW);
    expect(r).toEqual({ success: true, sent: true });
    expect(getActiveRecipientEmailsMock).toHaveBeenCalledWith('calendar-weekly');
    const mail = sendEmailMock.mock.calls[0][0] as any;
    expect(mail.to).toEqual(['a@x.de']);
    expect(mail.subject).toBe('Nächste Gäste · KW 48 · 23.11.–07.12.2026');
  });

  it('keine Empfänger: kein Versand', async () => {
    getActiveRecipientEmailsMock.mockReturnValue([]);
    expect(await sendCalendarWeeklyEmail(NOW)).toEqual({ success: true, sent: false, error: 'No recipients' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('Florenz: am 23.11. (Berlin) drin, am 24.11. und 30.11. nicht', async () => {
    await sendCalendarWeeklyEmail(NOW);
    expect((sendEmailMock.mock.calls[0][0] as any).html).toContain('Florenz');
    await sendCalendarWeeklyEmail(new Date('2026-11-24T05:00:00Z'));
    expect((sendEmailMock.mock.calls[1][0] as any).html).not.toContain('Florenz');
    await sendCalendarWeeklyEmail(new Date('2026-11-30T05:00:00Z'));
    expect((sendEmailMock.mock.calls[2][0] as any).html).not.toContain('Florenz');
  });

  it('Versandfehler -> sent:false', async () => {
    sendEmailMock.mockResolvedValueOnce(false);
    expect((await sendCalendarWeeklyEmail(NOW)).sent).toBe(false);
  });
});
