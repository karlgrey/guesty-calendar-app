import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertEventMock = vi.fn();
const deleteEventMock = vi.fn();
const listEventsMock = vi.fn();
vi.mock('../services/google-calendar-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/google-calendar-client.js')>();
  return {
    ...actual,
    googleCalendarClient: {
      upsertEvent: (...args: unknown[]) => upsertEventMock(...args),
      deleteEvent: (...args: unknown[]) => deleteEventMock(...args),
      listEvents: (...args: unknown[]) => listEventsMock(...args),
    },
  };
});

const getReservationsByPeriodMock = vi.fn();
const getCancelledReservationIdsMock = vi.fn();
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationsByPeriod: (...args: unknown[]) => getReservationsByPeriodMock(...args),
  getCancelledReservationIds: (...args: unknown[]) => getCancelledReservationIdsMock(...args),
}));

const getListingByIdMock = vi.fn();
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: (...args: unknown[]) => getListingByIdMock(...args),
}));

const getAvailabilityMock = vi.fn();
vi.mock('../repositories/availability-repository.js', () => ({
  getAvailability: (...args: unknown[]) => getAvailabilityMock(...args),
}));

const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
vi.mock('../utils/logger.js', () => ({
  default: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildCalendarEvent, syncGoogleCalendarForProperty } from './sync-google-calendar.js';
import { toGoogleEventId } from '../services/google-event-id.js';
import { blockEventId } from '../services/google-calendar-blocks.js';
import type { Reservation } from '../types/models.js';
import type { PropertyConfig } from '../config/properties.js';

function mkReservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 1, reservation_id: 'res-1', listing_id: 'L1', check_in: '2026-08-01', check_out: '2026-08-05',
    check_in_localized: '2026-08-01', check_out_localized: '2026-08-05', nights_count: 4,
    guest_id: null, guest_name: 'Darleen', guests_count: 2, adults_count: 2, children_count: 0, infants_count: 0,
    status: 'confirmed', confirmation_code: 'ABC', source: 'airbnb2', platform: 'airbnb2',
    planned_arrival: null, planned_departure: null, currency: 'EUR', total_price: 400, host_payout: 350,
    balance_due: null, total_paid: null, created_at_guesty: null, reserved_at: null, last_synced_at: '',
    internal_guest_id: null, guest_company: null,
    ...over,
  } as Reservation;
}

describe('buildCalendarEvent — Ganztages-Event-Enddatum (#406)', () => {
  it('addiert einen Tag für ein Nicht-DST-Checkout', () => {
    const res = mkReservation({ check_out_localized: '2026-08-05' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-08-06');
  });

  it('addiert korrekt einen Tag über den Frühjahrs-DST-Übergang Europe/Berlin (29.03.2026)', () => {
    const res = mkReservation({ check_out_localized: '2026-03-29' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-03-30');
  });

  it('addiert korrekt einen Tag über den Herbst-DST-Übergang Europe/Berlin (25.10.2026)', () => {
    const res = mkReservation({ check_out_localized: '2026-10-25' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-10-26');
  });

  it('addiert korrekt einen Tag über einen Jahreswechsel', () => {
    const res = mkReservation({ check_out_localized: '2026-12-31' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2027-01-01');
  });
});

function airbnbMailProperty(overrides: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    slug: 'firenze-loft',
    provider: 'airbnb-mail',
    airbnbListingId: 'listing-firenze',
    name: 'Urban Luxury Loft - Florence',
    timezone: 'Europe/Rome',
    currency: 'EUR',
    bookingRecipientEmail: 'firenze@example.com',
    bookingSenderName: 'Florence',
    weeklyReport: { enabled: false, recipients: [], day: 1, hour: 6 },
    googleCalendar: { enabled: true, calendarId: 'cal-firenze@group.calendar.google.com' },
    ...overrides,
  };
}

// #660: die App soll bei Storno das selbst angelegte Google-Calendar-Event
// wieder entfernen (Fall Mjalli Florenz, 15.09.2026 — Event blieb nach dem
// Storno stehen, Konsistenz-Check meldete "extra", Micha löschte manuell).
describe('syncGoogleCalendarForProperty — Storno löscht das Google-Event (#660)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getListingByIdMock.mockReturnValue(null);
    getReservationsByPeriodMock.mockReturnValue([]);
    getAvailabilityMock.mockReturnValue([]);
    upsertEventMock.mockResolvedValue('updated');
    listEventsMock.mockResolvedValue([]);
  });

  it('erkennt eine stornierte Reservierung, deren Event noch im Kalender steht, und löscht es', async () => {
    getCancelledReservationIdsMock.mockReturnValue(['HMBZN9WBY9']);
    deleteEventMock.mockResolvedValue(true);

    const result = await syncGoogleCalendarForProperty(airbnbMailProperty());

    expect(result.success).toBe(true);
    expect(result.eventsDeleted).toBe(1);
    expect(deleteEventMock).toHaveBeenCalledWith('cal-firenze@group.calendar.google.com', toGoogleEventId('HMBZN9WBY9'));

    // Spec: Vorgang loggen (Reservierung, Objekt, Event-ID, Grund).
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'HMBZN9WBY9',
        propertySlug: 'firenze-loft',
        eventId: toGoogleEventId('HMBZN9WBY9'),
        reason: expect.any(String),
      }),
      expect.stringContaining('deleted')
    );
  });

  it('ist idempotent: ein bereits fehlendes Event (404/410 → deleteEvent liefert false) ist kein Fehler', async () => {
    getCancelledReservationIdsMock.mockReturnValue(['HMBZN9WBY9']);
    deleteEventMock.mockResolvedValue(false); // wie google-calendar-client.ts bei 404/410

    const result = await syncGoogleCalendarForProperty(airbnbMailProperty());

    expect(result.success).toBe(true);
    expect(result.eventsDeleted).toBe(0);
    expect(loggerWarnMock).not.toHaveBeenCalled();

    // Zweiter Lauf (z. B. nächster Sync-Zyklus) verhält sich identisch — kein Doppel-Löschen, kein Fehler.
    const secondResult = await syncGoogleCalendarForProperty(airbnbMailProperty());
    expect(secondResult.success).toBe(true);
    expect(secondResult.eventsDeleted).toBe(0);
  });

  it('lässt manuell angelegte Kalender-Events unangetastet — die Storno-Löschung adressiert ausschließlich die konkreten stornierten Reservierungs-IDs', async () => {
    // Keine Stornos in diesem Lauf: die Reservierungs-Lösch-Logik ruft dann
    // überhaupt kein deleteEvent auf — sie iteriert NUR über
    // getCancelledReservationIds(), scannt nie den bestehenden Kalenderinhalt.
    getCancelledReservationIdsMock.mockReturnValue([]);
    // Ein manuell angelegtes Event ohne unsere extendedProperties-Markierung
    // taucht nur im Block-Cleanup-Scan auf (listEvents) und wird dort
    // ignoriert, weil es kein 'owner-block' ist.
    listEventsMock.mockResolvedValue([
      { id: 'manual-event-123', summary: 'Handwerker-Termin', extendedProperties: undefined },
    ]);

    const result = await syncGoogleCalendarForProperty(airbnbMailProperty());

    expect(result.success).toBe(true);
    expect(result.eventsDeleted).toBe(0);
    expect(result.blockEventsDeleted).toBe(0);
    expect(deleteEventMock).not.toHaveBeenCalled();
  });

  it('lässt fremde Owner-Block-Events, die (noch) zur Erwartung gehören, unangetastet — nur nicht mehr erwartete Blocks werden bereinigt', async () => {
    getCancelledReservationIdsMock.mockReturnValue([]);
    // Ein Event MIT owner-block-Markierung, dessen ID auch als "desired"
    // berechnet wird (Verfügbarkeits-Snapshot spiegelt genau dieses Event),
    // darf nicht gelöscht werden.
    getAvailabilityMock.mockReturnValue([
      { date: '2026-09-21', status: 'blocked', block_type: 'owner' },
    ]);
    listEventsMock.mockResolvedValue([
      {
        id: blockEventId('listing-firenze', '2026-09-21'),
        summary: 'Owner-Block',
        extendedProperties: { private: { kind: 'owner-block' } },
      },
    ]);
    upsertEventMock.mockResolvedValue('updated');

    const result = await syncGoogleCalendarForProperty(airbnbMailProperty());

    expect(result.success).toBe(true);
    expect(result.blockEventsDeleted).toBe(0);
    expect(deleteEventMock).not.toHaveBeenCalled();
  });
});
