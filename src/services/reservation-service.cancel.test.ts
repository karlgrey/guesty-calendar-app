// #771: POST /api/agent/reservations/:id/cancel — Hold vs. bestätigte Buchung.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guesty-client.js', () => ({
  guestyClient: {
    getReservation: vi.fn(),
    updateReservationStatus: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../repositories/availability-repository.js', () => ({ areDatesAvailable: vi.fn() }));
vi.mock('../repositories/reservation-repository.js', () => ({
  upsertReservation: vi.fn(),
  markReservationStatusLocally: vi.fn().mockReturnValue({ reservations: 1, inquiries: 1 }),
}));
vi.mock('./document-service.js', () => ({ createOrGetDocument: vi.fn() }));
vi.mock('../config/properties.js', () => ({
  getPropertyBySlug: vi.fn(),
  getPropertyByGuestyId: vi.fn((id: string) =>
    id === 'listing-fh'
      ? { slug: 'farmhouse', googleCalendar: { enabled: true, calendarId: 'cal-fh' } }
      : id === 'listing-nocal'
        ? { slug: 'u19', googleCalendar: { enabled: false } }
        : undefined),
}));
vi.mock('./google-calendar-client.js', () => ({
  googleCalendarClient: { deleteEvent: vi.fn().mockResolvedValue(true) },
}));

import { guestyClient } from './guesty-client.js';
import { markReservationStatusLocally } from '../repositories/reservation-repository.js';
import { googleCalendarClient } from './google-calendar-client.js';
import { toGoogleEventId } from './google-event-id.js';
import { cancelReservation, DEFAULT_CANCELLATION_REASON } from './reservation-service.js';
import { ConflictError } from '../utils/errors.js';

const getReservation = guestyClient.getReservation as any;
const updateStatus = guestyClient.updateReservationStatus as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cancelReservation (#771)', () => {
  it('bestätigte Buchung -> canceled mit Default-Grund, lokal nachgezogen, Google-Event gelöscht', async () => {
    getReservation.mockResolvedValue({ _id: 'res-1', status: 'confirmed', listingId: 'listing-fh' });
    const r = await cancelReservation('res-1');
    expect(updateStatus).toHaveBeenCalledWith('res-1', 'canceled', DEFAULT_CANCELLATION_REASON);
    expect(r).toEqual({ previousStatus: 'confirmed', newStatus: 'canceled', unchanged: false, googleEventDeleted: true });
    expect(markReservationStatusLocally).toHaveBeenCalledWith('res-1', 'canceled');
    expect(googleCalendarClient.deleteEvent).toHaveBeenCalledWith('cal-fh', toGoogleEventId('res-1'));
  });

  it('übergebener Grund geht an Guesty', async () => {
    getReservation.mockResolvedValue({ status: 'confirmed', listingId: 'listing-fh' });
    await cancelReservation('res-1', 'Guest cancelled');
    expect(updateStatus).toHaveBeenCalledWith('res-1', 'canceled', 'Guest cancelled');
  });

  it.each(['reserved', 'inquiry'])('Hold/Anfrage (%s) -> closed wie bisher', async (status) => {
    getReservation.mockResolvedValue({ status, listingId: 'listing-fh' });
    const r = await cancelReservation('res-2');
    expect(updateStatus).toHaveBeenCalledWith('res-2', 'closed');
    expect(r).toMatchObject({ previousStatus: status, newStatus: 'closed', unchanged: false });
    expect(markReservationStatusLocally).toHaveBeenCalledWith('res-2', 'closed');
  });

  it.each(['canceled', 'closed'])('schon %s -> No-op, kein Guesty-Write', async (status) => {
    getReservation.mockResolvedValue({ status, listingId: 'listing-fh' });
    const r = await cancelReservation('res-3');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(r).toEqual({ previousStatus: status, newStatus: status, unchanged: true, googleEventDeleted: null });
  });

  it.each(['checked_in', 'checked_out', 'declined', 'expired'])('%s -> 409, kein Write', async (status) => {
    getReservation.mockResolvedValue({ status, listingId: 'listing-fh' });
    await expect(cancelReservation('res-4')).rejects.toBeInstanceOf(ConflictError);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('ohne Google-Kalender am Objekt: kein Delete, googleEventDeleted null', async () => {
    getReservation.mockResolvedValue({ status: 'confirmed', listingId: 'listing-nocal' });
    const r = await cancelReservation('res-5');
    expect(googleCalendarClient.deleteEvent).not.toHaveBeenCalled();
    expect(r.googleEventDeleted).toBeNull();
  });

  it('Fehler beim lokalen Nachziehen/Google-Delete machen den Storno nicht zum Fehler', async () => {
    getReservation.mockResolvedValue({ status: 'confirmed', listingId: 'listing-fh' });
    (markReservationStatusLocally as any).mockImplementationOnce(() => { throw new Error('db'); });
    (googleCalendarClient.deleteEvent as any).mockRejectedValueOnce(new Error('google'));
    const r = await cancelReservation('res-6');
    expect(r).toMatchObject({ newStatus: 'canceled', googleEventDeleted: null });
  });

  it('Guesty-Fehler beim Status-Write schlägt durch (z. B. unbekannter Grund -> 400)', async () => {
    getReservation.mockResolvedValue({ status: 'confirmed', listingId: 'listing-fh' });
    updateStatus.mockRejectedValueOnce(new Error('400 invalid cancellationReason'));
    await expect(cancelReservation('res-7', 'Quatsch')).rejects.toThrow('400');
    expect(markReservationStatusLocally).not.toHaveBeenCalled();
  });
});
