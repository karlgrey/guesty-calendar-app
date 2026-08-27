import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: { ...mod.config, propertyTimezone: 'Europe/Berlin', consistencyAlertRecipients: [] },
  };
});

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getReservationsMock = vi.fn();
const getCalendarMock = vi.fn();
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getReservations: (...args: unknown[]) => getReservationsMock(...args),
    getCalendar: (...args: unknown[]) => getCalendarMock(...args),
  },
}));

const hostexGetReservationsMock = vi.fn();
const hostexGetPropertiesMock = vi.fn();
const hostexGetListingCalendarsMock = vi.fn();
const getHostexClientMock = vi.fn(() => ({
  getReservations: (...args: unknown[]) => hostexGetReservationsMock(...args),
  getProperties: (...args: unknown[]) => hostexGetPropertiesMock(...args),
  getListingCalendars: (...args: unknown[]) => hostexGetListingCalendarsMock(...args),
}));
vi.mock('../services/hostex-client.js', () => ({
  getHostexClient: (...args: unknown[]) => getHostexClientMock(...args),
}));

const fetchAirbnbIcalMock = vi.fn();
vi.mock('../services/airbnb-mail/ical-fetcher.js', () => ({
  fetchAirbnbIcal: (...args: unknown[]) => fetchAirbnbIcalMock(...args),
}));

const getListingByIdMock = vi.fn();
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: (...args: unknown[]) => getListingByIdMock(...args),
}));

const getAvailabilityLastSyncedAtMock = vi.fn();
vi.mock('../repositories/availability-repository.js', () => ({
  getAvailabilityLastSyncedAt: (...args: unknown[]) => getAvailabilityLastSyncedAtMock(...args),
}));

const listEventsMock = vi.fn();
vi.mock('../services/google-calendar-client.js', () => ({
  googleCalendarClient: { listEvents: (...args: unknown[]) => listEventsMock(...args) },
}));

const sendEmailMock = vi.fn();
vi.mock('../services/email-service.js', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const getAllPropertiesMock = vi.fn();
const getPropertyByGuestyIdMock = vi.fn();
const getPropertiesByProviderMock = vi.fn();
vi.mock('../config/properties.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    getAllProperties: (...args: unknown[]) => getAllPropertiesMock(...args),
    getPropertyByGuestyId: (...args: unknown[]) => getPropertyByGuestyIdMock(...args),
    getPropertiesByProvider: (...args: unknown[]) => getPropertiesByProviderMock(...args),
  };
});

import {
  buildExpectedEventsForProperty,
  runConsistencyCheck,
  listOpenReservations,
  runDailyConsistencyJob,
} from './consistency-check.js';
import type { PropertyConfig } from '../config/properties.js';

function guestyProperty(overrides: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    slug: 'farmhouse',
    provider: 'guesty',
    guestyPropertyId: 'listing-guesty-1',
    name: 'Farmhouse Prasser',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    bookingRecipientEmail: 'b@e.com',
    bookingSenderName: 'Farmhouse',
    weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
    googleCalendar: { enabled: true, calendarId: 'cal-farmhouse@group.calendar.google.com' },
    ...overrides,
  };
}

function hostexProperty(overrides: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    slug: 'alte-schilderwerkstatt',
    provider: 'hostex',
    hostexPropertyId: '12659676',
    name: 'Alte Schilderwerkstatt',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    bookingRecipientEmail: 'b@e.com',
    bookingSenderName: 'ASW',
    weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
    googleCalendar: { enabled: true, calendarId: 'cal-asw@group.calendar.google.com' },
    static: { accommodates: 4 },
    ...overrides,
  };
}

function airbnbProperty(overrides: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    slug: 'firenze-loft',
    provider: 'airbnb-mail',
    airbnbListingId: 'airbnb-firenze',
    airbnbIcalUrl: 'https://www.airbnb.com/calendar/ical/secret.ics',
    name: 'Firenze Loft',
    timezone: 'Europe/Rome',
    currency: 'EUR',
    bookingRecipientEmail: 'b@e.com',
    bookingSenderName: 'Firenze',
    weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
    googleCalendar: { enabled: true, calendarId: 'cal-firenze@group.calendar.google.com' },
    static: { accommodates: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildExpectedEventsForProperty — guesty', () => {
  it('baut Reservierungs- und Block-Events aus getReservations + getCalendar (live)', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: '68d1234567890abcdef12345',
        listingId: 'listing-guesty-1',
        status: 'confirmed',
        checkIn: '2026-10-04T15:00:00.000Z',
        checkOut: '2026-10-07T11:00:00.000Z',
        checkInDateLocalized: '2026-10-04',
        checkOutDateLocalized: '2026-10-07',
        guest: { fullName: 'Louisa Strasser' },
      },
    ]);
    getCalendarMock.mockResolvedValueOnce([
      {
        date: '2026-09-12',
        listingId: 'listing-guesty-1',
        currency: 'EUR',
        price: 100,
        minNights: 2,
        status: 'unavailable',
        blocks: { o: true },
      },
      {
        date: '2026-09-13',
        listingId: 'listing-guesty-1',
        currency: 'EUR',
        price: 100,
        minNights: 2,
        status: 'unavailable',
        blocks: { o: true },
      },
    ]);

    const { events, sourceCounts } = await buildExpectedEventsForProperty(guestyProperty(), '2026-09-01', '2026-10-29');

    expect(sourceCounts).toEqual({ reservations: 1, blockSpans: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reservation',
        reservationId: '68d1234567890abcdef12345',
        guestName: 'Louisa Strasser',
        status: 'confirmed',
        start: '2026-10-04',
        endExclusive: '2026-10-08',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'block', start: '2026-09-12', endExclusive: '2026-09-14' })
    );
    // Event-ID muss über toGoogleEventId normalisiert sein (reiner Hex-String, keine Sonderzeichen)
    const reservationEvent = events.find((e) => e.type === 'reservation')!;
    expect(reservationEvent.eventId).toBe('68d1234567890abcdef12345');
  });

  it('klippt Reservierungen außerhalb des Fensters weg (overlapsWindow)', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        listingId: 'listing-guesty-1',
        status: 'confirmed',
        checkInDateLocalized: '2026-01-01',
        checkOutDateLocalized: '2026-01-03',
        guest: { fullName: 'Weit weg' },
      },
    ]);
    getCalendarMock.mockResolvedValueOnce([]);

    const { events } = await buildExpectedEventsForProperty(guestyProperty(), '2026-09-01', '2026-09-29');
    expect(events).toEqual([]);
  });

  it('paginiert bei vollen Seiten (pageSize 100)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      _id: `res${String(i).padStart(20, '0')}`,
      listingId: 'listing-guesty-1',
      status: 'confirmed',
      checkInDateLocalized: '2026-09-05',
      checkOutDateLocalized: '2026-09-06',
      guest: { fullName: 'Gast' },
    }));
    getReservationsMock.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);
    getCalendarMock.mockResolvedValueOnce([]);

    await buildExpectedEventsForProperty(guestyProperty(), '2026-09-01', '2026-09-29');
    expect(getReservationsMock).toHaveBeenCalledTimes(2);
    expect(getReservationsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 100 }));
    expect(getReservationsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 100, skip: 100 }));
  });

  it('F5: begrenzt den Guesty-Reservations-Fetch mit checkOutGte=from', async () => {
    getReservationsMock.mockResolvedValueOnce([]);
    getCalendarMock.mockResolvedValueOnce([]);

    await buildExpectedEventsForProperty(guestyProperty(), '2026-09-01', '2026-09-29');
    expect(getReservationsMock).toHaveBeenCalledWith(expect.objectContaining({ checkOutGte: '2026-09-01' }));
  });

  it('F5: Guesty-Paginierungs-Sicherheitsgrenze erreicht -> warnt und markiert das Property-Ergebnis mit error', async () => {
    getReservationsMock.mockImplementation(async () =>
      Array.from({ length: 100 }, (_, i) => ({
        _id: `pageres${String(i).padStart(16, '0')}`,
        listingId: 'listing-guesty-1',
        status: 'confirmed',
        checkInDateLocalized: '2026-09-05',
        checkOutDateLocalized: '2026-09-06',
        guest: { fullName: 'Gast' },
      }))
    );
    getCalendarMock.mockResolvedValueOnce([]);

    const logger = (await import('../utils/logger.js')).default;
    const { error } = await buildExpectedEventsForProperty(guestyProperty(), '2026-09-01', '2026-09-29');
    expect(error).toBe('Guesty-Paginierung abgeschnitten — Ergebnis unvollständig');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'listing-guesty-1' }),
      expect.stringContaining('Seiten-Sicherheitsgrenze erreicht')
    );
  });
});

describe('buildExpectedEventsForProperty — hostex', () => {
  it('baut Reservierungs-Events via mapHostexReservation und Block-Events via mapHostexCalendarDay', async () => {
    hostexGetReservationsMock.mockResolvedValueOnce([
      {
        reservation_code: '0-HM533PZBP2-id3zpmfvbo',
        stay_code: '0-HM533PZBP2-id3zpmfvbo',
        channel_id: 'HM533PZBP2',
        channel_type: 'airbnb',
        listing_id: '1635436646666826858',
        property_id: 12659676,
        status: 'accepted',
        check_in_date: '2026-09-10',
        check_out_date: '2026-09-12',
        guest_name: 'Anke Morgenroth',
      },
    ]);
    hostexGetPropertiesMock.mockResolvedValueOnce([
      { id: 12659676, title: 'Alte Schilderwerkstatt', channels: [{ channel_type: 'airbnb', listing_id: '1635436646666826858', currency: 'EUR' }] },
    ]);
    hostexGetListingCalendarsMock.mockResolvedValueOnce({
      listings: [
        {
          listing_id: '1635436646666826858',
          channel_type: 'airbnb',
          calendar: [
            { date: '2026-09-20', price: 100, inventory: 0, restrictions: { min_stay_on_arrival: 1, max_stay_on_arrival: 30, closed_on_arrival: false, closed_on_departure: false } },
            { date: '2026-09-21', price: 100, inventory: 0, restrictions: { min_stay_on_arrival: 1, max_stay_on_arrival: 30, closed_on_arrival: false, closed_on_departure: false } },
          ],
        },
      ],
    });

    const { events, sourceCounts } = await buildExpectedEventsForProperty(hostexProperty(), '2026-09-01', '2026-09-29');

    expect(sourceCounts).toEqual({ reservations: 1, blockSpans: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reservation',
        reservationId: '0-HM533PZBP2-id3zpmfvbo',
        guestName: 'Anke Morgenroth',
        start: '2026-09-10',
        endExclusive: '2026-09-13',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'block', start: '2026-09-20', endExclusive: '2026-09-22' })
    );
  });

  it('überspringt Block-Diff, wenn kein Channel gefunden wird', async () => {
    hostexGetReservationsMock.mockResolvedValueOnce([]);
    hostexGetPropertiesMock.mockResolvedValueOnce([{ id: 12659676, title: 'X', channels: [] }]);

    const { events, sourceCounts } = await buildExpectedEventsForProperty(hostexProperty(), '2026-09-01', '2026-09-29');
    expect(events).toEqual([]);
    expect(sourceCounts).toEqual({ reservations: 0, blockSpans: 0 });
    expect(hostexGetListingCalendarsMock).not.toHaveBeenCalled();
  });

  it('F9: begrenzt getReservations mit endCheckIn=to (kein startCheckIn)', async () => {
    hostexGetReservationsMock.mockResolvedValueOnce([]);
    hostexGetPropertiesMock.mockResolvedValueOnce([{ id: 12659676, title: 'X', channels: [] }]);

    await buildExpectedEventsForProperty(hostexProperty(), '2026-09-01', '2026-09-29');
    expect(hostexGetReservationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ endCheckIn: '2026-09-29' })
    );
    expect(hostexGetReservationsMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ startCheckIn: expect.anything() })
    );
  });

  it('F9: nutzt übergebene hostexProperties statt selbst getProperties() zu rufen', async () => {
    hostexGetReservationsMock.mockResolvedValueOnce([]);
    const preloaded = [{ id: 12659676, title: 'X', channels: [] }] as any;

    await buildExpectedEventsForProperty(hostexProperty(), '2026-09-01', '2026-09-29', preloaded);
    expect(hostexGetPropertiesMock).not.toHaveBeenCalled();
  });
});

describe('buildExpectedEventsForProperty — airbnb-mail', () => {
  const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Airbnb Inc//Hosting Calendar 0.8.8//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260910
DTEND;VALUE=DATE:20260913
SUMMARY:Reserved
UID:opaque-uid-1@airbnb.com
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de
 tails/HMZ82HRR38
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260920
DTEND;VALUE=DATE:20260922
SUMMARY:Airbnb (Not available)
UID:opaque-uid-2@airbnb.com
END:VEVENT
END:VCALENDAR
`;

  it('baut Reservierungs-Events via groupBookedIntervals und Block-Events aus buildAvailabilityRows', async () => {
    fetchAirbnbIcalMock.mockResolvedValueOnce(ICS);
    getListingByIdMock.mockReturnValueOnce({ base_price: 150, min_nights: 2 });

    const { events, sourceCounts } = await buildExpectedEventsForProperty(airbnbProperty(), '2026-09-01', '2026-09-29');

    expect(sourceCounts).toEqual({ reservations: 1, blockSpans: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reservation',
        reservationId: 'HMZ82HRR38',
        start: '2026-09-10',
        endExclusive: '2026-09-14',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'block', start: '2026-09-20', endExclusive: '2026-09-22' })
    );
  });
});

describe('runConsistencyCheck', () => {
  it('meldet Diffs pro Property und isoliert Fehler einer Property (andere laufen weiter)', async () => {
    getAllPropertiesMock.mockReturnValue([
      guestyProperty({ slug: 'ok-prop', name: 'OK Property', guestyPropertyId: 'listing-ok' }),
      guestyProperty({ slug: 'broken-prop', name: 'Broken Property', guestyPropertyId: 'listing-broken' }),
    ]);

    // ok-prop: keine Reservierungen/Blocks erwartet, Google leer -> ok
    getReservationsMock.mockImplementation(async ({ listingId }: { listingId: string }) => {
      if (listingId === 'listing-broken') throw new Error('Guesty API 502');
      return [];
    });
    getCalendarMock.mockImplementation(async (listingId: string) => {
      if (listingId === 'listing-broken') throw new Error('Guesty API 502');
      return [];
    });
    listEventsMock.mockResolvedValue([]);
    getAvailabilityLastSyncedAtMock.mockReturnValue('2026-08-27T05:00:00.000Z');

    const report = await runConsistencyCheck(28);

    expect(report.properties).toHaveLength(2);
    const ok = report.properties.find((p) => p.slug === 'ok-prop')!;
    const broken = report.properties.find((p) => p.slug === 'broken-prop')!;
    expect(ok.ok).toBe(true);
    expect(ok.error).toBeNull();
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('502');
    expect(report.totalIssues).toBe(1);
  });

  it('F5: Guesty-Paginierungs-Abbruch markiert die Property mit error und zählt als Befund, ohne die anderen Properties zu blockieren', async () => {
    getAllPropertiesMock.mockReturnValue([
      guestyProperty({ slug: 'truncated', name: 'Truncated Property', guestyPropertyId: 'listing-truncated' }),
      guestyProperty({ slug: 'ok-prop', name: 'OK Property', guestyPropertyId: 'listing-ok' }),
    ]);
    getReservationsMock.mockImplementation(async ({ listingId }: { listingId: string }) => {
      if (listingId === 'listing-truncated') {
        return Array.from({ length: 100 }, (_, i) => ({
          _id: `pageres${String(i).padStart(16, '0')}`,
          listingId,
          status: 'confirmed',
          checkInDateLocalized: '2026-09-05',
          checkOutDateLocalized: '2026-09-06',
          guest: { fullName: 'Gast' },
        }));
      }
      return [];
    });
    getCalendarMock.mockResolvedValue([]);
    listEventsMock.mockResolvedValue([]);
    getAvailabilityLastSyncedAtMock.mockReturnValue(null);

    const report = await runConsistencyCheck(28);
    const truncated = report.properties.find((p) => p.slug === 'truncated')!;
    const ok = report.properties.find((p) => p.slug === 'ok-prop')!;
    expect(truncated.ok).toBe(false);
    expect(truncated.error).toBe('Guesty-Paginierung abgeschnitten — Ergebnis unvollständig');
    expect(ok.ok).toBe(true);
    expect(report.totalIssues).toBeGreaterThan(0);
  });

  it('zählt missing/extra/mismatched korrekt in totalIssues', async () => {
    getAllPropertiesMock.mockReturnValue([guestyProperty({ guestyPropertyId: 'listing-x' })]);
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        listingId: 'listing-x',
        status: 'confirmed',
        checkInDateLocalized: '2026-09-10',
        checkOutDateLocalized: '2026-09-12',
        guest: { fullName: 'Fehlt' },
      },
    ]);
    getCalendarMock.mockResolvedValueOnce([]);
    listEventsMock.mockResolvedValueOnce([
      { id: 'manual-event', summary: 'Manuell', start: { date: '2026-09-05' }, end: { date: '2026-09-06' } },
    ]);
    getAvailabilityLastSyncedAtMock.mockReturnValue(null);

    const report = await runConsistencyCheck(28);
    expect(report.totalIssues).toBe(2); // 1 missing + 1 extra
    expect(report.properties[0].missing).toHaveLength(1);
    expect(report.properties[0].extra).toHaveLength(1);
    expect(report.properties[0].cacheLastSyncedAt).toBeNull();
  });

  it('F9: lädt Hostex-getProperties() nur einmal pro Run, auch bei mehreren Hostex-Properties', async () => {
    getAllPropertiesMock.mockReturnValue([
      hostexProperty({ slug: 'hostex-a', hostexPropertyId: '111', googleCalendar: { enabled: true, calendarId: 'cal-a' } }),
      hostexProperty({ slug: 'hostex-b', hostexPropertyId: '222', googleCalendar: { enabled: true, calendarId: 'cal-b' } }),
    ]);
    hostexGetReservationsMock.mockResolvedValue([]);
    hostexGetPropertiesMock.mockResolvedValue([
      { id: 111, title: 'A', channels: [] },
      { id: 222, title: 'B', channels: [] },
    ]);
    listEventsMock.mockResolvedValue([]);
    getAvailabilityLastSyncedAtMock.mockReturnValue(null);

    const report = await runConsistencyCheck(28);
    expect(report.properties).toHaveLength(2);
    expect(hostexGetPropertiesMock).toHaveBeenCalledTimes(1);
  });

  it('ignoriert Properties ohne aktiviertes Google Calendar', async () => {
    getAllPropertiesMock.mockReturnValue([
      guestyProperty({ googleCalendar: { enabled: false } }),
    ]);
    const report = await runConsistencyCheck(28);
    expect(report.properties).toEqual([]);
    expect(getReservationsMock).not.toHaveBeenCalled();
  });
});

describe('listOpenReservations', () => {
  it('filtert nach Status und mappt unbekanntes Guesty-Listing auf property: null', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'res-1',
        listingId: 'unknown-listing',
        status: 'reserved',
        checkInDateLocalized: '2026-10-01',
        checkOutDateLocalized: '2026-10-03',
        createdAt: '2026-08-01T00:00:00.000Z',
        guest: { fullName: 'Unbekannt' },
      },
    ]);
    getPropertiesByProviderMock.mockReturnValue([]);
    getPropertyByGuestyIdMock.mockReturnValue(undefined);

    const result = await listOpenReservations(['reserved', 'inquiry'], false);
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({ provider: 'guesty', reservationId: 'res-1', property: null, listingId: 'unknown-listing' });
    expect(result.errors).toEqual([]);
  });

  it('includePast=false filtert vergangene Check-ins raus', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'past-1', listingId: 'L', status: 'reserved',
        checkInDateLocalized: '2020-01-01', checkOutDateLocalized: '2020-01-03',
        createdAt: '2019-12-01T00:00:00.000Z',
      },
    ]);
    getPropertiesByProviderMock.mockReturnValue([]);
    getPropertyByGuestyIdMock.mockReturnValue(undefined);

    const result = await listOpenReservations(['reserved'], false);
    expect(result.reservations).toEqual([]);
  });

  it('includePast=true behält vergangene Check-ins', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'past-1', listingId: 'L', status: 'reserved',
        checkInDateLocalized: '2020-01-01', checkOutDateLocalized: '2020-01-03',
        createdAt: '2019-12-01T00:00:00.000Z',
      },
    ]);
    getPropertiesByProviderMock.mockReturnValue([]);
    getPropertyByGuestyIdMock.mockReturnValue(undefined);

    const result = await listOpenReservations(['reserved'], true);
    expect(result.reservations).toHaveLength(1);
  });

  it('F5: nutzt checkOutGte=heute bei includePast=false', async () => {
    getReservationsMock.mockResolvedValueOnce([]);
    getPropertiesByProviderMock.mockReturnValue([]);

    await listOpenReservations(['reserved'], false);
    expect(getReservationsMock).toHaveBeenCalledWith(expect.objectContaining({ checkOutGte: '2026-08-27' }));
  });

  it('F5: kein checkOutGte-Filter bei includePast=true', async () => {
    getReservationsMock.mockResolvedValueOnce([]);
    getPropertiesByProviderMock.mockReturnValue([]);

    await listOpenReservations(['reserved'], true);
    expect(getReservationsMock).toHaveBeenCalledWith(expect.not.objectContaining({ checkOutGte: expect.anything() }));
  });

  it('kombiniert Guesty + Hostex, sortiert nach createdAt aufsteigend', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'g-1', listingId: 'L1', status: 'reserved',
        checkInDateLocalized: '2026-10-01', checkOutDateLocalized: '2026-10-03',
        createdAt: '2026-08-15T00:00:00.000Z',
      },
    ]);
    getPropertyByGuestyIdMock.mockReturnValue({ slug: 'farmhouse', name: 'Farmhouse Prasser', shortCode: 'FH' });
    getPropertiesByProviderMock.mockReturnValue([hostexProperty()]);
    hostexGetReservationsMock.mockResolvedValueOnce([
      {
        reservation_code: 'h-1', stay_code: 'h-1', channel_id: 'CH1', channel_type: 'airbnb',
        listing_id: '12659676', property_id: 12659676, status: 'wait_pay',
        check_in_date: '2026-10-05', check_out_date: '2026-10-07',
        guest_name: 'Früher Hold', booked_at: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const result = await listOpenReservations(['reserved', 'inquiry'], false);
    expect(result.reservations.map((r) => r.reservationId)).toEqual(['h-1', 'g-1']);
  });

  it('F4: Guesty-Fehler isoliert — Hostex-Ergebnis bleibt erhalten, Fehler landet in errors', async () => {
    getReservationsMock.mockRejectedValueOnce(new Error('Guesty API 503'));
    getPropertiesByProviderMock.mockReturnValue([hostexProperty()]);
    getPropertyByGuestyIdMock.mockReturnValue(undefined);
    hostexGetReservationsMock.mockResolvedValueOnce([
      {
        reservation_code: 'h-1', stay_code: 'h-1', channel_id: 'CH1', channel_type: 'airbnb',
        listing_id: '12659676', property_id: 12659676, status: 'wait_pay',
        check_in_date: '2026-10-05', check_out_date: '2026-10-07',
        guest_name: 'Hold', booked_at: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const result = await listOpenReservations(['reserved', 'inquiry'], false);
    expect(result.reservations.map((r) => r.reservationId)).toEqual(['h-1']);
    expect(result.errors).toEqual([{ provider: 'guesty', error: 'Guesty API 503' }]);
  });

  it('F4: Hostex-Fehler isoliert — Guesty-Ergebnis bleibt erhalten, Fehler landet in errors', async () => {
    getReservationsMock.mockResolvedValueOnce([
      {
        _id: 'g-1', listingId: 'L1', status: 'reserved',
        checkInDateLocalized: '2026-10-01', checkOutDateLocalized: '2026-10-03',
        createdAt: '2026-08-15T00:00:00.000Z',
      },
    ]);
    getPropertyByGuestyIdMock.mockReturnValue(undefined);
    getPropertiesByProviderMock.mockReturnValue([hostexProperty()]);
    hostexGetReservationsMock.mockRejectedValueOnce(new Error('Hostex 500'));

    const result = await listOpenReservations(['reserved', 'inquiry'], false);
    expect(result.reservations.map((r) => r.reservationId)).toEqual(['g-1']);
    expect(result.errors).toEqual([{ provider: 'hostex', error: 'Hostex 500' }]);
  });

  it('F4: konstruiert keinen Hostex-Client, wenn keine Hostex-Properties existieren', async () => {
    getReservationsMock.mockResolvedValueOnce([]);
    getPropertiesByProviderMock.mockReturnValue([]);

    const result = await listOpenReservations(['reserved', 'inquiry'], false);
    expect(result.reservations).toEqual([]);
    expect(getHostexClientMock).not.toHaveBeenCalled();
  });
});

describe('runDailyConsistencyJob', () => {
  it('sendet keine Mail, wenn Report leer und keine überfälligen Holds', async () => {
    getAllPropertiesMock.mockReturnValue([]);
    getReservationsMock.mockResolvedValue([]);
    getPropertiesByProviderMock.mockReturnValue([]);

    await runDailyConsistencyJob();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('F4: Hold-Sweep-Fehler (leerer Report, keine Stale Holds) löst trotzdem einen Alert aus', async () => {
    getAllPropertiesMock.mockReturnValue([]); // Report selbst ohne Befund
    getReservationsMock.mockRejectedValue(new Error('Guesty komplett down'));
    getPropertiesByProviderMock.mockReturnValue([]);

    const { config } = await import('../config/index.js');
    const originalRecipients = config.consistencyAlertRecipients;
    (config as any).consistencyAlertRecipients = ['ops@example.com'];
    sendEmailMock.mockResolvedValueOnce(true);

    try {
      await runDailyConsistencyJob();
    } finally {
      (config as any).consistencyAlertRecipients = originalRecipients;
    }

    // Ein isolierter Hold-Sweep-Fehler (per-Provider try/catch, F4) darf den
    // Report-Versand nicht verhindern — im Gegenteil, er ist selbst ein
    // Alert-würdiger Befund (silent-failure-Risiko genau das, wovor der
    // Check schützen soll).
    expect(sendEmailMock).toHaveBeenCalled();
  });
});
