import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: {
      ...mod.config,
      agentApiKey: 'test-agent-key-0123456789abcdef0123456789',
      agentApiKeySet: ['test-agent-key-0123456789abcdef0123456789'],
    },
  };
});
vi.mock('../services/reservation-service.js', () => ({
  createOfferReservation: vi.fn().mockResolvedValue({
    reservationId: 'res-1', guestId: 'guest-1', documentNumber: 'A-2026-0042',
    holdUntil: '2026-08-07', priceSource: 'manual',
  }),
  confirmOfferReservation: vi.fn().mockResolvedValue(undefined),
  cancelReservation: vi.fn().mockResolvedValue({
    previousStatus: 'reserved', newStatus: 'closed', unchanged: false, googleEventDeleted: true,
  }),
}));
// #792: PATCH /reservations/:id — Service gemockt (Logik in reservation-update-service.test.ts),
// toReservationView bleibt echt.
const updateReservationMock = vi.fn();
vi.mock('../services/reservation-update-service.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, updateReservation: (...args: unknown[]) => updateReservationMock(...args) };
});
vi.mock('../services/document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fake'), isNew: false,
  }),
  refreshDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fresh'), isNew: false,
  }),
  createCancellationForInvoice: vi.fn().mockResolvedValue({
    document: { id: 115, documentNumber: '2026-0036', documentType: 'cancellation', total: -518950, currency: 'EUR', createdAt: '2026-09-30 13:00:00' },
    invoice: { id: 114, documentNumber: '2026-0035' },
    pdf: Buffer.from('%PDF-storno'), isNew: true,
  }),
  getCancellationWithPDF: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getReservation: vi.fn().mockResolvedValue({ _id: 'res-1', status: 'reserved' }),
    updateGuest: vi.fn().mockResolvedValue(undefined),
    getListing: vi.fn(),
    getListingFinancials: vi.fn(),
    updateListingCleaningFee: vi.fn().mockResolvedValue(undefined),
    getGuest: vi.fn().mockResolvedValue({
      _id: 'guest-1', firstName: 'Lenia', lastName: 'K.', fullName: 'Lenia K.',
      email: 'l@example.com', phones: ['+49 30 1'], company: 'momox SE',
      address: { street: 'Straße 1', city: 'Berlin', zipcode: '10115', country: 'DE', full: 'Straße 1, 10115 Berlin' },
      notes: 'intern', tags: ['vip'],
    }),
  },
}));
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsUpdatedSince: vi.fn().mockReturnValue([
    {
      id: 'hostex:a', listing_id: 'L1', source: 'hostex', channel: 'airbnb',
      guest_name: 'Anna', guest_email: 'anna@example.com',
      last_message_at: '2026-08-05T10:00:00.000Z', last_message_direction: 'inbound',
    },
    {
      id: 'guesty:b', listing_id: 'L2', source: 'guesty', channel: 'airbnb',
      guest_name: 'Ben', guest_email: 'ben@example.com',
      last_message_at: '2026-08-04T09:00:00.000Z', last_message_direction: 'outbound',
    },
  ]),
  getThreadById: vi.fn((id: string) =>
    id === 'hostex:a'
      ? {
          id: 'hostex:a', listing_id: 'L1', source: 'hostex', channel: 'airbnb',
          guest_name: 'Anna', guest_email: 'anna@example.com',
          last_message_at: '2026-08-05T10:00:00.000Z',
        }
      : null,
  ),
  getMessagesByThread: vi.fn().mockReturnValue([
    { id: 'm1', thread_id: 'hostex:a', direction: 'inbound', sent_at: '2026-08-05T09:00:00.000Z', from_name: 'Anna', body: 'Frage zum Check-in', source: 'hostex' },
    { id: 'm2', thread_id: 'hostex:a', direction: 'outbound', sent_at: '2026-08-05T10:00:00.000Z', from_name: 'host', body: 'Antwort', source: 'hostex' },
  ]),
}));
const listAutoDecisionCasesMock = vi.fn();
vi.mock('../repositories/draft-repository.js', () => ({
  getAwaitingDrafts: vi.fn().mockReturnValue([{
    id: 'd1', thread_id: 'hostex:a', provider: 'hostex', status: 'pending', created_at: '2026-09-19 12:00:00',
    reason: 'Kategorie Sonderwunsch — nie automatisch', guest_name: 'Anna', listing_id: 'L1', source: 'hostex',
    last_guest_message: 'Könnten wir schon um 11 Uhr rein? Wir sind früh da.\nDanke!',
  }, {
    // #697: Buchungsanfrage-Draft (Fall Anika) — auto_decision='auto', live gesendet, mit Frist.
    id: 'd2', thread_id: 'guesty:b', provider: 'guesty', status: 'sent', created_at: '2026-09-21 20:35:10',
    reason: 'Antwort automatisch gesendet — Annahme/Ablehnung in Airbnb bei Micha',
    guest_name: 'Anika', listing_id: 'L1', source: 'guesty',
    last_guest_message: 'Ich würde gern für ein Event buchen.',
    smarttasks_task_id: 701, request_kind: 'request_to_book', platform_deadline_at: '2026-09-22T20:35:04.000Z',
    auto_category: 'buchungsanfrage', auto_decision: 'auto', auto_mode: 'live',
  }]),
  getAutoSendStats: vi.fn().mockReturnValue({ autoSent: 2, waited: 3, shadowWouldAuto: 10, shadowUnchanged: 9, shadowChanged: 1, shadowDiscarded: 0 }),
  // #1044: Einzelfälle des Gates
  listAutoDecisionCases: (...args: unknown[]) => listAutoDecisionCasesMock(...args),
}));
const runConsistencyCheckMock = vi.fn();
const listOpenReservationsMock = vi.fn();
vi.mock('../jobs/consistency-check.js', () => ({
  runConsistencyCheck: (...args: unknown[]) => runConsistencyCheckMock(...args),
  listOpenReservations: (...args: unknown[]) => listOpenReservationsMock(...args),
}));
vi.mock('../utils/thread-property.js', () => ({
  propertyForBadge: vi.fn((thread: { listing_id: string | null }) =>
    thread.listing_id === 'L1'
      ? { slug: 'farmhouse', name: 'Farmhouse Prasser', shortCode: 'FH' }
      : thread.listing_id === 'L2'
        ? { slug: 'uferstrasse', name: 'Uferstraße 19', shortCode: 'U19' }
        : undefined,
  ),
}));
// #729: PUT /guests/:guestId spiegelt company in reservations.guest_company —
// Repository-Funktion gemockt, DB-Verhalten selbst hat einen eigenen Test
// (reservation-repository.guest-company-update.test.ts).
vi.mock('../repositories/reservation-repository.js', () => ({
  updateGuestCompanyByGuestId: vi.fn().mockReturnValue(2),
}));

// #799: Zeit-Abweichungen — Service gemockt (Logik in stay-times-service.test.ts)
const getStayTimesMock = vi.fn();
const setStayTimesMock = vi.fn();
const deleteStayTimesMock = vi.fn();
vi.mock('../services/stay-times-service.js', () => ({
  getStayTimes: (...a: unknown[]) => getStayTimesMock(...a),
  setStayTimes: (...a: unknown[]) => setStayTimesMock(...a),
  deleteStayTimes: (...a: unknown[]) => deleteStayTimesMock(...a),
}));

// #725: Hostex Owner-Blocks — Client mocken, echte properties.json (Slug
// bootshaus-alte-oder, hostexPropertyId '12659677') wie bei /reservations.
const getAvailabilitiesMock = vi.fn();
const updateAvailabilitiesMock = vi.fn();
const getHostexClientMock = vi.fn(() => ({
  getAvailabilities: (...args: unknown[]) => getAvailabilitiesMock(...args),
  updateAvailabilities: (...args: unknown[]) => updateAvailabilitiesMock(...args),
}));
vi.mock('../services/hostex-client.js', () => ({
  getHostexClient: (...args: unknown[]) => getHostexClientMock(...args),
}));
const getListingTextsMock = vi.fn();
vi.mock('../services/listing-texts-service.js', () => ({
  getListingTextsForProperty: (...args: unknown[]) => getListingTextsMock(...args),
}));

// #1055: Verfügbarkeits-Sync-Route — Jobs gemockt, Logik in den Job-Tests.
const syncAvailabilityMock = vi.fn();
vi.mock('../jobs/sync-availability.js', () => ({
  syncAvailability: (...a: unknown[]) => syncAvailabilityMock(...a),
}));
const syncHostexPropertyMock = vi.fn();
vi.mock('../jobs/hostex/sync-properties.js', () => ({
  syncHostexProperty: (...a: unknown[]) => syncHostexPropertyMock(...a),
}));
const syncHostexReservationsMock = vi.fn();
vi.mock('../jobs/hostex/sync-reservations.js', () => ({
  syncHostexReservations: (...a: unknown[]) => syncHostexReservationsMock(...a),
}));
const syncHostexCalendarMock = vi.fn();
vi.mock('../jobs/hostex/sync-calendar.js', () => ({
  syncHostexCalendar: (...a: unknown[]) => syncHostexCalendarMock(...a),
}));

// #1137: Cache-Auffrischung nach Reinigungsgebühr-Update — Job gemockt.
const syncListingMock = vi.fn();
vi.mock('../jobs/sync-listing.js', () => ({
  syncListing: (...a: unknown[]) => syncListingMock(...a),
}));

import agentApiRoutes from './agent-api.js';
import { getPropertyBySlug, getListingId } from '../config/properties.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

const KEY = { 'X-Agent-Key': 'test-agent-key-0123456789abcdef0123456789', 'Content-Type': 'application/json' };

describe('agent-api', () => {
  it('401 ohne Key', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', body: '{}' , headers: { 'Content-Type': 'application/json' }});
    expect(r.status).toBe(401);
  });

  it('POST /reservations → 201 mit Service-Ergebnis', async () => {
    const r = await fetch(`${base}/api/agent/reservations`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ propertySlug: 'farmhouse', checkIn: '2026-09-09', checkOut: '2026-09-10', guestsCount: 15, guest: { firstName: 'N', lastName: 'L', email: 'n@x.de' }, priceGross: 2850 }),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ reservationId: 'res-1', documentNumber: 'A-2026-0042' });
  });

  it('GET /reservations/:id → Guesty-Status', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'reserved' });
  });

  it('GET /reservations/:id → plannedArrival/plannedDeparture/source (#792)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.getReservation as any).mockResolvedValueOnce({
      _id: 'res-1', status: 'confirmed', source: 'manual', plannedArrival: '15:00', plannedDeparture: '11:00',
    });
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(await r.json()).toMatchObject({ source: 'manual', plannedArrival: '15:00', plannedDeparture: '11:00' });
  });

  it('PATCH /reservations/:id → 200 mit Service-Ergebnis, Body durchgereicht (#792)', async () => {
    updateReservationMock.mockResolvedValueOnce({ id: 'res-1', checkIn: '2026-11-30', actualTotal: 3456.1 });
    const body = { checkIn: '2026-11-30', checkOut: '2026-12-02', guestsCount: 6 };
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { method: 'PATCH', headers: KEY, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ actualTotal: 3456.1 });
    expect(updateReservationMock).toHaveBeenCalledWith('res-1', body);
  });

  it('PATCH /reservations/:id → 400/409 aus dem Service werden durchgereicht (#792)', async () => {
    const { ValidationError, ConflictError } = await import('../utils/errors.js');
    updateReservationMock.mockRejectedValueOnce(new ValidationError('Body ist leer — erlaubt: checkIn'));
    let r = await fetch(`${base}/api/agent/reservations/res-1`, { method: 'PATCH', headers: KEY, body: '{}' });
    expect(r.status).toBe(400);
    updateReservationMock.mockRejectedValueOnce(new ConflictError('im Ursprungskanal ändern'));
    r = await fetch(`${base}/api/agent/reservations/res-1`, { method: 'PATCH', headers: KEY, body: '{"guestsCount":3}' });
    expect(r.status).toBe(409);
  });

  it('PATCH /reservations/:id → 401 ohne Key (#792)', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { method: 'PATCH', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(r.status).toBe(401);
  });

  it('GET /reservations/:id → guestId aus guest._id (#557)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.getReservation as any).mockResolvedValueOnce({
      _id: 'res-1', status: 'reserved', guest: { _id: 'guest-42', fullName: 'Anna' },
    });
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ guestId: 'guest-42' });
  });

  it('GET /reservations/:id → guestId null ohne Guest-Daten', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.getReservation as any).mockResolvedValueOnce({ _id: 'res-1', status: 'reserved' });
    const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ guestId: null });
  });

  it('GET /reservations/:id/offer.pdf → PDF mit Nummer im Header', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1/offer.pdf`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('x-document-number')).toBe('A-2026-0042');
  });

  it('offer.pdf?refresh=1 nutzt refreshDocument', async () => {
    const { refreshDocument, createOrGetDocument } = await import('../services/document-service.js');
    (createOrGetDocument as any).mockClear(); (refreshDocument as any).mockClear();
    const r = await fetch(`${base}/api/agent/reservations/res-1/offer.pdf?refresh=1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(refreshDocument).toHaveBeenCalledOnce();
    expect(createOrGetDocument).not.toHaveBeenCalled();
  });

  it('GET /reservations/:id/invoice.pdf → PDF mit Nummer im Header', async () => {
    const r = await fetch(`${base}/api/agent/reservations/res-1/invoice.pdf`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('x-document-number')).toBe('A-2026-0042');
    expect(r.headers.get('content-disposition')).toContain('Rechnung_A-2026-0042.pdf');
  });

  it('invoice.pdf?refresh=1 nutzt refreshDocument', async () => {
    const { refreshDocument, createOrGetDocument } = await import('../services/document-service.js');
    (createOrGetDocument as any).mockClear(); (refreshDocument as any).mockClear();
    const r = await fetch(`${base}/api/agent/reservations/res-1/invoice.pdf?refresh=1`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(refreshDocument).toHaveBeenCalledOnce();
    expect(createOrGetDocument).not.toHaveBeenCalled();
  });

  it('PUT /guests/:id → updateGuest', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ address: { city: 'Potsdam' } }),
    });
    expect(r.status).toBe(200);
    expect(guestyClient.updateGuest).toHaveBeenCalledWith('guest-1', { address: { city: 'Potsdam' } });
  });

  it('PUT /guests/:id reicht company durch (#715)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.updateGuest as any).mockClear();
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY,
      body: JSON.stringify({ company: 'momox SE', email: 'x@momox.com', address: { city: 'Berlin' } }),
    });
    expect(r.status).toBe(200);
    expect(guestyClient.updateGuest).toHaveBeenCalledWith('guest-1', {
      company: 'momox SE', email: 'x@momox.com', address: { city: 'Berlin' },
    });
  });

  it('PUT /guests/:id mit company spiegelt reservations.guest_company für den guest_id (#729)', async () => {
    const { updateGuestCompanyByGuestId } = await import('../repositories/reservation-repository.js');
    (updateGuestCompanyByGuestId as any).mockClear();
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ company: 'momox SE' }),
    });
    expect(r.status).toBe(200);
    expect(updateGuestCompanyByGuestId).toHaveBeenCalledWith('guest-1', 'momox SE');
  });

  it('PUT /guests/:id ohne company im Body ruft updateGuestCompanyByGuestId NICHT (#729)', async () => {
    const { updateGuestCompanyByGuestId } = await import('../repositories/reservation-repository.js');
    (updateGuestCompanyByGuestId as any).mockClear();
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ email: 'x@momox.com' }),
    });
    expect(r.status).toBe(200);
    expect(updateGuestCompanyByGuestId).not.toHaveBeenCalled();
  });

  it('PUT /guests/:id mit company: null löscht reservations.guest_company (#729)', async () => {
    const { updateGuestCompanyByGuestId } = await import('../repositories/reservation-repository.js');
    (updateGuestCompanyByGuestId as any).mockClear();
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ company: null }),
    });
    expect(r.status).toBe(200);
    expect(updateGuestCompanyByGuestId).toHaveBeenCalledWith('guest-1', null);
  });

  it('PUT /guests/:id → 400 bei unbekanntem Feld (Whitelist, nichts blind an Guesty) (#715)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.updateGuest as any).mockClear();
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({ phones: ['+49 1'] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('phones');
    expect(guestyClient.updateGuest).not.toHaveBeenCalled();
  });

  it('PUT /guests/:id → 400 bei leerem Body (#715)', async () => {
    const r = await fetch(`${base}/api/agent/guests/guest-1`, {
      method: 'PUT', headers: KEY, body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('GET /guests/:id → Ist-Stand ohne interne Felder (#715)', async () => {
    const r = await fetch(`${base}/api/agent/guests/guest-1`, { headers: KEY });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      id: 'guest-1', firstName: 'Lenia', lastName: 'K.', fullName: 'Lenia K.',
      email: 'l@example.com', phone: '+49 30 1', company: 'momox SE',
      address: { street: 'Straße 1', city: 'Berlin', zipcode: '10115', country: 'DE', full: 'Straße 1, 10115 Berlin' },
    });
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('tags');
  });

  it('GET /guests/:id → null-Felder statt undefined bei dünnem Guesty-Datensatz (#715)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    (guestyClient.getGuest as any).mockResolvedValueOnce({ _id: 'guest-2', firstName: 'Ben' });
    const r = await fetch(`${base}/api/agent/guests/guest-2`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      id: 'guest-2', firstName: 'Ben', lastName: null, fullName: null, email: null,
      phone: null, company: null, address: null,
    });
  });

  it('GET /guests/:id → 404 wenn Guesty 404 liefert (#715)', async () => {
    const { guestyClient } = await import('../services/guesty-client.js');
    const { ExternalApiError } = await import('../utils/errors.js');
    (guestyClient.getGuest as any).mockRejectedValueOnce(new ExternalApiError('Guesty API error: 404 Not Found', 404, 'Guesty'));
    const r = await fetch(`${base}/api/agent/guests/nope`, { headers: KEY });
    expect(r.status).toBe(404);
  });

  it('confirm + cancel → 200', async () => {
    const c = await fetch(`${base}/api/agent/reservations/res-1/confirm`, { method: 'POST', headers: KEY });
    expect(c.status).toBe(200);
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(200);
    expect(await x.json()).toEqual({
      ok: true, previousStatus: 'reserved', newStatus: 'closed', unchanged: false, googleEventDeleted: true,
    });
  });

  it('cancel reicht reason an den Service durch (#771)', async () => {
    const { cancelReservation } = await import('../services/reservation-service.js');
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ reason: '  Guest Convenience ' }),
    });
    expect(x.status).toBe(200);
    expect(cancelReservation).toHaveBeenLastCalledWith('res-1', 'Guest Convenience', undefined);
  });

  it('cancel: Grund außerhalb der Guesty-Liste → 400 mit erlaubten Werten, kein Service-Aufruf (#776)', async () => {
    const { cancelReservation } = await import('../services/reservation-service.js');
    (cancelReservation as any).mockClear();
    const bad = await fetch(`${base}/api/agent/reservations/res-1/cancel`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ reason: 'Cancelled by guest' }),
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error).toContain('Guest Convenience');
    expect(body.error).toContain('No Reason Provided');
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  it('cancel reicht canceledBy durch, ungültiger Wert → 400', async () => {
    const { cancelReservation } = await import('../services/reservation-service.js');
    const ok = await fetch(`${base}/api/agent/reservations/res-1/cancel`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ reason: 'Personal Circumstances', canceledBy: 'GUEST' }),
    });
    expect(ok.status).toBe(200);
    expect(cancelReservation).toHaveBeenLastCalledWith('res-1', 'Personal Circumstances', 'GUEST');
    const bad = await fetch(`${base}/api/agent/reservations/res-1/cancel`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ canceledBy: 'NOBODY' }),
    });
    expect(bad.status).toBe(400);
  });

  it('cancel: ExternalApiError liefert details in der Antwort', async () => {
    const { cancelReservation } = await import('../services/reservation-service.js');
    const { ExternalApiError } = await import('../utils/errors.js');
    const details = { message: 'Invalid cancellationReason' };
    (cancelReservation as any).mockRejectedValueOnce(
      new ExternalApiError('Guesty API error: 400 Bad Request', 400, 'guesty', details));
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(400);
    expect(await x.json()).toEqual({ error: 'Guesty API error: 400 Bad Request', details });
  });

  it('cancel mit leerem/ungültigem reason → 400 (#771)', async () => {
    for (const reason of ['', 42]) {
      const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ reason }),
      });
      expect(x.status).toBe(400);
    }
  });

  it('cancel: Konflikt aus dem Service → 409 (#771)', async () => {
    const { cancelReservation } = await import('../services/reservation-service.js');
    const { ConflictError } = await import('../utils/errors.js');
    (cancelReservation as any).mockRejectedValueOnce(new ConflictError("Reservierung im Status 'checked_in' ist nicht stornierbar"));
    const x = await fetch(`${base}/api/agent/reservations/res-1/cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(409);
  });

  it('POST invoice-cancel → 201 mit Storno-Nummer und Verweis auf die Rechnung (#771)', async () => {
    const x = await fetch(`${base}/api/agent/reservations/res-1/invoice-cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(201);
    expect(await x.json()).toMatchObject({
      ok: true, isNew: true, documentId: 115, documentNumber: '2026-0036', documentType: 'cancellation',
      cancelsDocumentId: 114, cancelsDocumentNumber: '2026-0035', total: -5189.5, currency: 'EUR',
      pdfPath: '/api/agent/reservations/res-1/cancellation.pdf',
    });
  });

  it('POST invoice-cancel bereits vorhanden → 200 isNew=false (#771)', async () => {
    const { createCancellationForInvoice } = await import('../services/document-service.js');
    const base_ = await (createCancellationForInvoice as any)();
    (createCancellationForInvoice as any).mockResolvedValueOnce({ ...base_, isNew: false });
    const x = await fetch(`${base}/api/agent/reservations/res-1/invoice-cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(200);
    expect((await x.json()).isNew).toBe(false);
  });

  it('POST invoice-cancel ohne Rechnung → 404 (#771)', async () => {
    const { createCancellationForInvoice } = await import('../services/document-service.js');
    const { NotFoundError } = await import('../utils/errors.js');
    (createCancellationForInvoice as any).mockRejectedValueOnce(new NotFoundError('Keine Rechnung'));
    const x = await fetch(`${base}/api/agent/reservations/res-1/invoice-cancel`, { method: 'POST', headers: KEY });
    expect(x.status).toBe(404);
  });

  it('GET cancellation.pdf: 404 ohne Beleg, PDF mit Nummer-Header wenn vorhanden (#771)', async () => {
    const none = await fetch(`${base}/api/agent/reservations/res-1/cancellation.pdf`, { headers: KEY });
    expect(none.status).toBe(404);
    const { getCancellationWithPDF } = await import('../services/document-service.js');
    (getCancellationWithPDF as any).mockResolvedValueOnce({
      document: { documentNumber: '2026-0036' }, pdf: Buffer.from('%PDF-storno'), isNew: false,
    });
    const r = await fetch(`${base}/api/agent/reservations/res-1/cancellation.pdf`, { headers: KEY });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('x-document-number')).toBe('2026-0036');
    expect(r.headers.get('content-disposition')).toContain('Stornorechnung_2026-0036.pdf');
  });

  it('GET /threads → Liste mit Property/Gastname/needsReply, neueste zuerst', async () => {
    const r = await fetch(`${base}/api/agent/threads`, { headers: KEY });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.threads).toHaveLength(2);
    expect(body.threads[0]).toMatchObject({
      threadId: 'hostex:a', source: 'hostex',
      property: { slug: 'farmhouse', name: 'Farmhouse Prasser', code: 'FH', shortCode: 'FH' },
      guestName: 'Anna', needsReply: true,
      lastMessageAt: '2026-08-05T10:00:00.000Z', lastMessageDirection: 'inbound',
      autoDecision: null,
    });
    expect(body.threads[1]).toMatchObject({
      threadId: 'guesty:b', needsReply: false, lastMessageDirection: 'outbound',
      property: { slug: 'uferstrasse', name: 'Uferstraße 19', code: 'U19' },
    });
  });

  it('GET /threads ohne Key → 401', async () => {
    const r = await fetch(`${base}/api/agent/threads`);
    expect(r.status).toBe(401);
  });

  it('GET /threads/:id → Thread mit Nachrichten aufsteigend', async () => {
    const r = await fetch(`${base}/api/agent/threads/hostex:a`, { headers: KEY });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      threadId: 'hostex:a', source: 'hostex', channel: 'airbnb',
      property: { slug: 'farmhouse', name: 'Farmhouse Prasser', code: 'FH' },
      guestName: 'Anna',
    });
    expect(body.messages).toEqual([
      { direction: 'inbound', sender: 'Anna', body: 'Frage zum Check-in', sentAt: '2026-08-05T09:00:00.000Z' },
      { direction: 'outbound', sender: 'host', body: 'Antwort', sentAt: '2026-08-05T10:00:00.000Z' },
    ]);
  });

  it('GET /threads/:id → 404 bei unbekannter ID', async () => {
    const r = await fetch(`${base}/api/agent/threads/does-not-exist`, { headers: KEY });
    expect(r.status).toBe(404);
  });

  it('AppError des Service wird als Statuscode gemappt (ValidationError→400)', async () => {
    const { createOfferReservation } = await import('../services/reservation-service.js');
    const { ValidationError } = await import('../utils/errors.js');
    (createOfferReservation as any).mockRejectedValueOnce(new ValidationError('bad input'));
    const r = await fetch(`${base}/api/agent/reservations`, { method: 'POST', headers: KEY, body: '{}' });
    expect(r.status).toBe(400);
  });

  describe('GET /consistency-check', () => {
    it('200 mit Default days=28', async () => {
      runConsistencyCheckMock.mockResolvedValueOnce({
        checkedAt: '2026-08-27T06:00:00.000Z', windowDays: 28, from: '2026-08-27', to: '2026-09-24',
        totalIssues: 0, properties: [],
      });
      const r = await fetch(`${base}/api/agent/consistency-check`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(runConsistencyCheckMock).toHaveBeenCalledWith(28);
      const body = await r.json();
      expect(body).toMatchObject({ windowDays: 28, totalIssues: 0 });
    });

    it('nutzt den übergebenen days-Parameter', async () => {
      runConsistencyCheckMock.mockResolvedValueOnce({
        checkedAt: 'x', windowDays: 7, from: 'a', to: 'b', totalIssues: 0, properties: [],
      });
      const r = await fetch(`${base}/api/agent/consistency-check?days=7`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(runConsistencyCheckMock).toHaveBeenCalledWith(7);
    });

    it.each(['0', '91', 'abc'])('400 bei ungültigem days=%s', async (days) => {
      const r = await fetch(`${base}/api/agent/consistency-check?days=${days}`, { headers: KEY });
      expect(r.status).toBe(400);
    });

    it('401 ohne Key', async () => {
      const r = await fetch(`${base}/api/agent/consistency-check`);
      expect(r.status).toBe(401);
    });
  });

  describe('GET /reservations (offene Holds)', () => {
    it('200 mit Default-Status reserved,inquiry', async () => {
      listOpenReservationsMock.mockResolvedValueOnce({
        reservations: [
          { provider: 'guesty', reservationId: 'r1', property: null, listingId: 'L', status: 'reserved', guestName: 'X', checkIn: '2026-09-01', checkOut: '2026-09-03', source: null, confirmationCode: null, createdAt: '2026-08-01T00:00:00.000Z' },
        ],
        errors: [],
      });
      const r = await fetch(`${base}/api/agent/reservations?status=reserved,inquiry`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(listOpenReservationsMock).toHaveBeenCalledWith(['reserved', 'inquiry'], false);
      const body = await r.json();
      expect(body.statuses).toEqual(['reserved', 'inquiry']);
      expect(body.reservations).toHaveLength(1);
      expect(body.errors).toEqual([]);
    });

    it('F4: gibt Provider-Fehler aus listOpenReservations im Response-JSON mit aus', async () => {
      listOpenReservationsMock.mockResolvedValueOnce({
        reservations: [],
        errors: [{ provider: 'hostex', error: 'Hostex 500' }],
      });
      const r = await fetch(`${base}/api/agent/reservations`, { headers: KEY });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.errors).toEqual([{ provider: 'hostex', error: 'Hostex 500' }]);
    });

    it('includePast=true wird durchgereicht', async () => {
      listOpenReservationsMock.mockResolvedValueOnce({ reservations: [], errors: [] });
      const r = await fetch(`${base}/api/agent/reservations?includePast=true`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(listOpenReservationsMock).toHaveBeenCalledWith(['reserved', 'inquiry'], true);
    });

    it('400 bei unbekanntem Status', async () => {
      const callsBefore = listOpenReservationsMock.mock.calls.length;
      const r = await fetch(`${base}/api/agent/reservations?status=reserved,quatsch`, { headers: KEY });
      expect(r.status).toBe(400);
      expect(listOpenReservationsMock.mock.calls.length).toBe(callsBefore);
    });

    it('401 ohne Key', async () => {
      const r = await fetch(`${base}/api/agent/reservations`);
      expect(r.status).toBe(401);
    });

    it('#521: property-Filter laesst nur Reservierungen des angefragten Slugs durch', async () => {
      listOpenReservationsMock.mockResolvedValueOnce({
        reservations: [
          { provider: 'guesty', reservationId: 'r1', property: { slug: 'farmhouse', name: 'Farmhouse Prasser', code: 'FH' }, listingId: 'L1', status: 'reserved', guestName: 'X', checkIn: '2026-09-01', checkOut: '2026-09-03', source: null, confirmationCode: null, createdAt: '2026-08-01T00:00:00.000Z' },
          { provider: 'airbnb-mail', reservationId: 'r2', property: { slug: 'firenze-loft', name: 'Urban Luxury Loft - Florence', code: 'FL' }, listingId: 'L2', status: 'reserved', guestName: 'Y', checkIn: '2026-09-05', checkOut: '2026-09-08', source: null, confirmationCode: null, createdAt: '2026-08-02T00:00:00.000Z' },
        ],
        errors: [],
      });
      const r = await fetch(`${base}/api/agent/reservations?property=firenze-loft`, { headers: KEY });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.reservations).toHaveLength(1);
      expect(body.reservations[0].reservationId).toBe('r2');
    });

    it('#521: 400 bei unbekanntem property-Slug mit Liste der gueltigen Slugs', async () => {
      const callsBefore = listOpenReservationsMock.mock.calls.length;
      const r = await fetch(`${base}/api/agent/reservations?property=florenz`, { headers: KEY });
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.error).toMatch(/florenz/);
      expect(body.error).toMatch(/firenze-loft/);
      expect(listOpenReservationsMock.mock.calls.length).toBe(callsBefore);
    });
  });

  describe('GET /drafts/awaiting', () => {
    it('liefert wartende Entwürfe mit Auszug und Admin-URL', async () => {
      const res = await fetch(`${base}/api/agent/drafts/awaiting?since=2026-09-19T00:00:00Z`, { headers: KEY });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.drafts[0]).toMatchObject({ draftId: 'd1', threadId: 'hostex:a', guestName: 'Anna', reason: 'Kategorie Sonderwunsch — nie automatisch' });
      expect(body.drafts[0].property).toMatchObject({ shortCode: 'FH' });
      expect(body.drafts[0].guestMessageExcerpt).toBe('Könnten wir schon um 11 Uhr rein? Wir sind früh da.');
      expect(body.drafts[0].adminUrl).toMatch(/\/admin\/messages\/hostex%3Aa$/);
      expect(body.drafts[0].createdAt).toBe('2026-09-19T12:00:00.000Z');
      // #697: neue Felder auf einem "normalen" Draft ohne Buchungsanfrage sind null.
      expect(body.drafts[0]).toMatchObject({ platformDeadlineAt: null, requestKind: null, category: null, autoDecision: null, autoMode: null });
    });

    it('#697: Buchungsanfrage-Draft liefert requestKind/platformDeadlineAt/category/autoDecision/autoMode + smartTasksTaskId', async () => {
      const res = await fetch(`${base}/api/agent/drafts/awaiting?since=2026-09-19T00:00:00Z`, { headers: KEY });
      const body = await res.json();
      const d2 = body.drafts.find((d: any) => d.draftId === 'd2');
      expect(d2).toMatchObject({
        threadId: 'guesty:b', guestName: 'Anika',
        reason: 'Antwort automatisch gesendet — Annahme/Ablehnung in Airbnb bei Micha',
        smartTasksTaskId: 701, requestKind: 'request_to_book', category: 'buchungsanfrage',
        autoDecision: 'auto', autoMode: 'live', platformDeadlineAt: '2026-09-22T20:35:04.000Z',
      });
    });

    it('400 bei ungültigem since', async () => {
      expect((await fetch(`${base}/api/agent/drafts/awaiting?since=gestern`, { headers: KEY })).status).toBe(400);
    });

    it('401 ohne Key', async () => {
      const r = await fetch(`${base}/api/agent/drafts/awaiting`);
      expect(r.status).toBe(401);
    });
  });

  describe('GET /auto-send/stats', () => {
    it('liefert Zähler + Quote', async () => {
      const body = await (await fetch(`${base}/api/agent/auto-send/stats?days=1`, { headers: KEY })).json();
      expect(body).toMatchObject({ autoSent: 2, waited: 3, shadowWouldAuto: 10, shadowUnchanged: 9, shadowChanged: 1, shadowDiscarded: 0, shadowUnchangedRate: 90 });
    });

    it('401 ohne Key', async () => {
      const r = await fetch(`${base}/api/agent/auto-send/stats`);
      expect(r.status).toBe(401);
    });
  });

  describe('GET /auto-send/decisions (#1044)', () => {
    const base_ = {
      thread_id: 'hostex:a', provider: 'hostex', guest_name: 'Anna', listing_id: 'L1', source: 'hostex',
      auto_category: 'dank_smalltalk', auto_decision: 'auto', auto_mode: 'shadow', auto_reason: 'ok',
      auto_judge_reasoning: null, auto_flags: '["mech:url"]', auto_judged_at: '2026-10-05 10:00:05',
      created_at: '2026-10-05 10:00:00', sent_at: null, sent_by: null, sent_body_changed: null,
      status: 'pending', body: 'Entwurf', feedback_json: '[]',
    };
    beforeEach(() => {
      listAutoDecisionCasesMock.mockReset();
      listAutoDecisionCasesMock.mockReturnValue([
        { ...base_, id: 'c1', status: 'sent', sent_by: 'micha', sent_body_changed: 1, body: 'Gesendet geändert',
          sent_at: '2026-10-05 11:00:00',
          feedback_json: '[{"category":"ton","note":"zu förmlich","createdAt":"2026-10-05 11:01:00"}]' },
        { ...base_, id: 'c2', status: 'sent', sent_by: 'micha', sent_body_changed: 0, body: 'Unverändert', sent_at: '2026-10-05 11:00:00' },
        { ...base_, id: 'c3', status: 'discarded', body: 'Verworfen', auto_flags: null, auto_judged_at: null },
        // #1062: geänderter Fall MIT gesichertem Ursprungstext (Migration 039)
        { ...base_, id: 'c4', status: 'sent', sent_by: 'micha', sent_body_changed: 1, sent_at: '2026-10-05 11:00:00',
          original_body: 'Hallo Anna,\nCheck-in ab 15 Uhr.', body: 'Hallo Anna,\nCheck-in ab 16 Uhr.' },
      ]);
    });

    it('liefert Einzelfälle mit Outcome und Texten', async () => {
      const r = await fetch(`${base}/api/agent/auto-send/decisions?days=7`, { headers: KEY });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ days: 7, decision: 'all', count: 4 });
      const [c1, c2, c3, c4] = body.decisions;
      expect(c1).toMatchObject({
        draftId: 'c1', threadId: 'hostex:a', provider: 'hostex', guestName: 'Anna', category: 'dank_smalltalk',
        decision: 'auto', mode: 'shadow', reason: 'ok', judgeReasoning: null, flags: ['mech:url'],
        outcome: 'changed', draftText: null, sentText: 'Gesendet geändert', draftTextLost: true,
        createdAt: '2026-10-05T10:00:00.000Z', judgedAt: '2026-10-05T10:00:05.000Z', sentAt: '2026-10-05T11:00:00.000Z',
      });
      expect(c1.feedback).toEqual([{ category: 'ton', note: 'zu förmlich', createdAt: '2026-10-05T11:01:00.000Z' }]);
      expect(c2).toMatchObject({ outcome: 'unchanged', draftText: 'Unverändert', sentText: 'Unverändert', draftTextLost: false, feedback: [] });
      expect(c3).toMatchObject({ outcome: 'discarded', draftText: 'Verworfen', sentText: null, flags: [], judgedAt: null, sentAt: null });
      expect(c1.diff).toBeNull();
      expect(c2.diff).toBeNull();
      // #1062: original_body → draftText + sentText + diff
      expect(c4).toMatchObject({
        outcome: 'changed', draftText: 'Hallo Anna,\nCheck-in ab 15 Uhr.', sentText: 'Hallo Anna,\nCheck-in ab 16 Uhr.',
        draftTextLost: false, diff: '@@ -1,2 +1,2 @@\n Hallo Anna,\n-Check-in ab 15 Uhr.\n+Check-in ab 16 Uhr.',
      });
    });

    it('reicht decision und limit ans Repository durch', async () => {
      await fetch(`${base}/api/agent/auto-send/decisions?decision=auto&limit=5`, { headers: KEY });
      expect(listAutoDecisionCasesMock).toHaveBeenCalledWith(expect.any(String), 'auto', 5);
      await fetch(`${base}/api/agent/auto-send/decisions`, { headers: KEY });
      expect(listAutoDecisionCasesMock).toHaveBeenLastCalledWith(expect.any(String), null, 200);
    });

    it('400 bei unbekanntem decision', async () => {
      expect((await fetch(`${base}/api/agent/auto-send/decisions?decision=foo`, { headers: KEY })).status).toBe(400);
    });

    it('400 bei ungültigem days/limit, Kappung bei days=3650 und limit=500', async () => {
      for (const q of ['days=abc', 'days=0', 'days=-5', 'limit=abc', 'limit=0']) {
        expect((await fetch(`${base}/api/agent/auto-send/decisions?${q}`, { headers: KEY })).status, q).toBe(400);
      }
      // days=1e9 würde ohne Kappung Date#toISOString zum RangeError (500) bringen
      const r = await fetch(`${base}/api/agent/auto-send/decisions?days=1000000000&limit=9999`, { headers: KEY });
      expect(r.status).toBe(200);
      expect((await r.json()).days).toBe(3650);
      expect(listAutoDecisionCasesMock).toHaveBeenLastCalledWith(expect.any(String), null, 500);
    });

    it('401 ohne Key', async () => {
      expect((await fetch(`${base}/api/agent/auto-send/decisions`)).status).toBe(401);
    });
  });

  // #725: Hostex Owner-Blocks. Systemzeit fixiert (Default-from/to und die
  // Vergangenheits-Prüfung hängen an "heute"), echter Slug bootshaus-alte-oder
  // (hostexPropertyId '12659677') aus data/properties.json wie bei /reservations.
  describe('GET/POST /availability/:slug (#725, Hostex Owner-Blocks)', () => {
    beforeEach(() => {
      // Nur die Systemzeit einfrieren (kein vi.useFakeTimers()) — sonst hängt
      // fetch() gegen den lokalen Test-Server, weil Node/undici intern auf
      // echte Timer angewiesen sind.
      vi.setSystemTime(new Date('2026-09-25T08:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('200 GET mit gruppierten Bereichen (3 Tage blocked, 1 frei, 2 blocked → 2 Ranges)', async () => {
      getAvailabilitiesMock.mockResolvedValueOnce([
        {
          id: 12659677,
          availabilities: [
            { date: '2027-07-19', available: false, remarks: 'Sommercamp' },
            { date: '2027-07-20', available: false, remarks: '' },
            { date: '2027-07-21', available: false, remarks: '' },
            { date: '2027-07-22', available: true, remarks: '' },
            { date: '2027-07-23', available: false, remarks: 'Zweiter Block' },
            { date: '2027-07-24', available: false, remarks: '' },
          ],
        },
      ]);
      const r = await fetch(
        `${base}/api/agent/availability/bootshaus-alte-oder?from=2027-07-19&to=2027-07-24`,
        { headers: KEY },
      );
      expect(r.status).toBe(200);
      expect(getAvailabilitiesMock).toHaveBeenCalledWith(['12659677'], '2027-07-19', '2027-07-24');
      const body = await r.json();
      expect(body.property).toMatchObject({ slug: 'bootshaus-alte-oder', provider: 'hostex', hostexPropertyId: '12659677' });
      expect(body.from).toBe('2027-07-19');
      expect(body.to).toBe('2027-07-24');
      expect(body.days).toHaveLength(6);
      expect(body.blockedRanges).toEqual([
        { from: '2027-07-19', to: '2027-07-21', nights: 3, remarks: 'Sommercamp' },
        { from: '2027-07-23', to: '2027-07-24', nights: 2, remarks: 'Zweiter Block' },
      ]);
    });

    it('Default from=heute (Berlin), to=from+365 Tage ohne Query-Parameter', async () => {
      getAvailabilitiesMock.mockResolvedValueOnce([{ id: 12659677, availabilities: [] }]);
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(getAvailabilitiesMock).toHaveBeenCalledWith(['12659677'], '2026-09-25', '2027-09-25');
      const body = await r.json();
      expect(body.from).toBe('2026-09-25');
      expect(body.to).toBe('2027-09-25');
    });

    it('400 bei from > to', async () => {
      const r = await fetch(
        `${base}/api/agent/availability/bootshaus-alte-oder?from=2026-08-01&to=2026-07-01`,
        { headers: KEY },
      );
      expect(r.status).toBe(400);
    });

    it('400 bei ungültigem Datum', async () => {
      const r = await fetch(
        `${base}/api/agent/availability/bootshaus-alte-oder?from=2026-13-40&to=2026-13-41`,
        { headers: KEY },
      );
      expect(r.status).toBe(400);
    });

    it('400 bei Zeitraum > 400 Tagen', async () => {
      const r = await fetch(
        `${base}/api/agent/availability/bootshaus-alte-oder?from=2026-09-25&to=2028-01-01`,
        { headers: KEY },
      );
      expect(r.status).toBe(400);
    });

    it('400 bei Guesty-Slug (z. B. farmhouse)', async () => {
      const r = await fetch(`${base}/api/agent/availability/farmhouse`, { headers: KEY });
      expect(r.status).toBe(400);
    });

    it('404 bei unbekanntem Slug', async () => {
      const r = await fetch(`${base}/api/agent/availability/does-not-exist`, { headers: KEY });
      expect(r.status).toBe(404);
    });

    it('401 ohne Key', async () => {
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder`);
      expect(r.status).toBe(401);
    });

    it('200 POST block ruft updateAvailabilities mit available=false und propertyIds [12659677]', async () => {
      updateAvailabilitiesMock.mockResolvedValueOnce({ ok: true });
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder/block`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ from: '2027-07-19', to: '2027-08-01' }),
      });
      expect(r.status).toBe(200);
      expect(updateAvailabilitiesMock).toHaveBeenCalledWith({
        propertyIds: ['12659677'], startDate: '2027-07-19', endDate: '2027-08-01', available: false,
      });
      const body = await r.json();
      expect(body).toMatchObject({
        from: '2027-07-19', to: '2027-08-01', available: false, nights: 14, async: true,
        note: 'Hostex verarbeitet asynchron — Stand mit GET /availability prüfen',
      });
      expect(body.property).toMatchObject({ slug: 'bootshaus-alte-oder', hostexPropertyId: '12659677' });
    });

    it('200 POST unblock mit available=true', async () => {
      updateAvailabilitiesMock.mockResolvedValueOnce({ ok: true });
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder/unblock`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ from: '2027-07-19', to: '2027-08-01' }),
      });
      expect(r.status).toBe(200);
      expect(updateAvailabilitiesMock).toHaveBeenCalledWith({
        propertyIds: ['12659677'], startDate: '2027-07-19', endDate: '2027-08-01', available: true,
      });
      const body = await r.json();
      expect(body).toMatchObject({ from: '2027-07-19', to: '2027-08-01', available: true, nights: 14, async: true });
    });

    it('400 bei POST block ohne from/to', async () => {
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder/block`, {
        method: 'POST', headers: KEY, body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
    });

    it('400 wenn to in der Vergangenheit liegt', async () => {
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder/block`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ from: '2026-01-01', to: '2026-01-02' }),
      });
      expect(r.status).toBe(400);
    });

    it('401 ohne Key bei POST block', async () => {
      const r = await fetch(`${base}/api/agent/availability/bootshaus-alte-oder/block`, {
        method: 'POST', body: JSON.stringify({ from: '2027-07-19', to: '2027-08-01' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(r.status).toBe(401);
    });
  });

  describe('Zeit-Abweichungen /reservations/:id/times (#799)', () => {
    const times = { effectiveDeparture: '18:00', override: { plannedDeparture: '18:00' } };
    beforeEach(() => { getStayTimesMock.mockReset(); setStayTimesMock.mockReset(); deleteStayTimesMock.mockReset(); });

    it('GET /reservations/:id enthält times (lokale Zeile) bzw. null', async () => {
      getStayTimesMock.mockReturnValueOnce({ times });
      let r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
      expect(await r.json()).toMatchObject({ status: 'reserved', times });
      getStayTimesMock.mockReturnValueOnce(null);
      r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
      expect((await r.json()).times).toBeNull();
    });

    it('GET /reservations/:id: Lookup-Fehler ist non-fatal (times null)', async () => {
      getStayTimesMock.mockImplementationOnce(() => { throw new Error('db'); });
      const r = await fetch(`${base}/api/agent/reservations/res-1`, { headers: KEY });
      expect(r.status).toBe(200);
      expect((await r.json()).times).toBeNull();
    });

    it('GET /reservations/:id/times -> 200 / 404', async () => {
      getStayTimesMock.mockReturnValueOnce({ reservationId: 'res-1', times });
      let r = await fetch(`${base}/api/agent/reservations/res-1/times`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ reservationId: 'res-1' });
      getStayTimesMock.mockReturnValueOnce(null);
      r = await fetch(`${base}/api/agent/reservations/nix/times`, { headers: KEY });
      expect(r.status).toBe(404);
    });

    it('PUT -> 200, Body und source agent durchgereicht', async () => {
      setStayTimesMock.mockResolvedValueOnce({ ok: true, reservationId: 'res-1', times, nextDayBlock: { applied: false, method: 'none' }, calendarSync: 'angestoßen' });
      const body = { plannedDeparture: '18:00', blockNextDay: true };
      const r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method: 'PUT', headers: KEY, body: JSON.stringify(body) });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, calendarSync: 'angestoßen' });
      expect(setStayTimesMock).toHaveBeenCalledWith('res-1', body, 'agent');
    });

    it('PUT -> 400/404/409 aus dem Service werden durchgereicht', async () => {
      const { ValidationError, NotFoundError, ConflictError } = await import('../utils/errors.js');
      for (const [err, status] of [[new ValidationError('x'), 400], [new NotFoundError('x'), 404], [new ConflictError('x'), 409]] as const) {
        setStayTimesMock.mockRejectedValueOnce(err);
        const r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method: 'PUT', headers: KEY, body: '{}' });
        expect(r.status).toBe(status);
      }
    });

    it('PUT mit Guesty-Block-Fehler -> 409 mit error/details, Override-Stand im Body', async () => {
      setStayTimesMock.mockResolvedValueOnce({
        ok: true, reservationId: 'res-1', times, calendarSync: 'angestoßen',
        nextDayBlock: { applied: false, method: 'listing-calendar', reason: 'Guesty-Aufruf fehlgeschlagen: x' },
        blockError: { message: 'Guesty API error', details: { m: 'dates blocked' } },
      });
      const r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method: 'PUT', headers: KEY, body: '{"blockNextDay":true}' });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({
        error: expect.stringContaining('Guesty API error'), details: { m: 'dates blocked' },
        times, nextDayBlock: { applied: false, method: 'listing-calendar' },
      });
    });

    it('DELETE -> 200 / 404', async () => {
      deleteStayTimesMock.mockResolvedValueOnce({ ok: true, reservationId: 'res-1', times: { override: null }, nextDayBlock: { applied: true, method: 'reservation' }, calendarSync: 'angestoßen' });
      let r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method: 'DELETE', headers: KEY });
      expect(r.status).toBe(200);
      expect(deleteStayTimesMock).toHaveBeenCalledWith('res-1');
      const { NotFoundError } = await import('../utils/errors.js');
      deleteStayTimesMock.mockRejectedValueOnce(new NotFoundError('keine'));
      r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method: 'DELETE', headers: KEY });
      expect(r.status).toBe(404);
    });

    it('401 ohne Key', async () => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const r = await fetch(`${base}/api/agent/reservations/res-1/times`, { method, headers: { 'Content-Type': 'application/json' } });
        expect(r.status).toBe(401);
      }
    });
  });
  describe('GET /listings/:id (#1043)', () => {
    it('Guesty-Objekt per Slug: Texte + Gästeanleitungen', async () => {
      getListingTextsMock.mockResolvedValueOnce({
        available: true, source: 'guesty',
        texts: {
          publicDescription: { summary: 'S', space: 'Sp', access: null, neighborhood: null, transit: null, notes: null, interactionWithGuests: null, houseRules: 'HR' },
          guestInstructions: { checkInNotes: 'N', checkOutInstructions: null },
        },
      });
      const r = await fetch(`${base}/api/agent/listings/farmhouse`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        property: { slug: 'farmhouse', provider: 'guesty' }, available: true,
        publicDescription: { summary: 'S', houseRules: 'HR' },
        guestInstructions: { checkInNotes: 'N' },
      });
    });

    it('Hostex-Objekt: null + Hinweis', async () => {
      getListingTextsMock.mockResolvedValueOnce({ available: false, source: 'hostex', texts: null, note: 'keine Beschreibungsfelder' });
      const r = await fetch(`${base}/api/agent/listings/bootshaus-alte-oder`, { headers: KEY });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ available: false, publicDescription: null, guestInstructions: null, note: 'keine Beschreibungsfelder' });
    });

    it('404 bei unbekanntem Listing, 401 ohne Key', async () => {
      let r = await fetch(`${base}/api/agent/listings/gibts-nicht`, { headers: KEY });
      expect(r.status).toBe(404);
      r = await fetch(`${base}/api/agent/listings/farmhouse`);
      expect(r.status).toBe(401);
    });
  });
  describe('POST /availability/:slug/sync (#1055)', () => {
    const farmhouseListingId = getListingId(getPropertyBySlug('farmhouse')!);
    const post = (slug: string, qs = '', headers: Record<string, string> = KEY) =>
      fetch(`${base}/api/agent/availability/${slug}/sync${qs}`, { method: 'POST', headers });

    beforeEach(() => {
      syncAvailabilityMock.mockReset();
      syncHostexPropertyMock.mockReset();
      syncHostexReservationsMock.mockReset();
      syncHostexCalendarMock.mockReset();
    });

    it('401 ohne Key', async () => {
      const r = await post('farmhouse', '', { 'Content-Type': 'application/json' });
      expect(r.status).toBe(401);
      expect(syncAvailabilityMock).not.toHaveBeenCalled();
    });

    it('404 bei unbekanntem Slug', async () => {
      const r = await post('gibts-nicht');
      expect(r.status).toBe(404);
      expect((await r.json()).error).toContain('Unbekanntes property: gibts-nicht');
    });

    it('guesty: ruft syncAvailability(listingId, false), 200', async () => {
      syncAvailabilityMock.mockResolvedValueOnce({ success: true, skipped: false, daysCount: 365 });
      const r = await post('farmhouse');
      expect(r.status).toBe(200);
      expect(syncAvailabilityMock).toHaveBeenCalledWith(farmhouseListingId, false);
      expect(await r.json()).toMatchObject({
        success: true,
        message: 'Availability synced successfully',
        property: { slug: 'farmhouse', provider: 'guesty', listingId: farmhouseListingId },
        force: false,
        result: { success: true, skipped: false, daysCount: 365 },
      });
    });

    it('guesty: ?force=true wird durchgereicht', async () => {
      syncAvailabilityMock.mockResolvedValueOnce({ success: true, skipped: false });
      const r = await post('farmhouse', '?force=true');
      expect(r.status).toBe(200);
      expect(syncAvailabilityMock).toHaveBeenCalledWith(farmhouseListingId, true);
      expect((await r.json()).force).toBe(true);
    });

    it('guesty: skipped → Cache-frisch-Message', async () => {
      syncAvailabilityMock.mockResolvedValueOnce({ success: true, skipped: true });
      const r = await post('farmhouse');
      expect(r.status).toBe(200);
      expect((await r.json()).message).toBe('Availability cache is fresh, no sync needed');
    });

    it('guesty: success false → 502 mit gleichem Body', async () => {
      syncAvailabilityMock.mockResolvedValueOnce({ success: false, skipped: false, error: 'boom' });
      const r = await post('farmhouse');
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({
        success: false, message: 'Availability sync failed', result: { error: 'boom' },
      });
    });

    it('guesty: geworfener Fehler → handleError (500)', async () => {
      syncAvailabilityMock.mockRejectedValueOnce(new Error('kaputt'));
      const r = await post('farmhouse');
      expect(r.status).toBe(500);
    });

    it('hostex: property → reservations → calendar in Reihenfolge, 200, daysCount', async () => {
      const order: string[] = [];
      const hostexProperty = { id: '12659677' };
      syncHostexPropertyMock.mockImplementationOnce(async () => { order.push('property'); return { success: true, hostexProperty }; });
      syncHostexReservationsMock.mockImplementationOnce(async () => { order.push('reservations'); return { success: true, inquiriesCount: 0, confirmedCount: 2 }; });
      syncHostexCalendarMock.mockImplementationOnce(async () => { order.push('calendar'); return { success: true, daysCount: 365 }; });
      const r = await post('bootshaus-alte-oder', '?force=true');
      expect(r.status).toBe(200);
      expect(order).toEqual(['property', 'reservations', 'calendar']);
      expect(syncHostexCalendarMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'bootshaus-alte-oder' }), hostexProperty);
      const body = await r.json();
      expect(body).toMatchObject({
        success: true,
        message: 'Availability synced successfully',
        property: { slug: 'bootshaus-alte-oder', provider: 'hostex' },
        result: { daysCount: 365 },
      });
      expect(syncAvailabilityMock).not.toHaveBeenCalled();
    });

    it('hostex: Kalender-Sync fehlgeschlagen → 502', async () => {
      syncHostexPropertyMock.mockResolvedValueOnce({ success: true, hostexProperty: { id: '1' } });
      syncHostexReservationsMock.mockResolvedValueOnce({ success: true });
      syncHostexCalendarMock.mockResolvedValueOnce({ success: false, daysCount: 0, error: 'x' });
      const r = await post('bootshaus-alte-oder');
      expect(r.status).toBe(502);
      expect((await r.json()).message).toBe('Availability sync failed');
    });

    it('hostex: property-sync fehlgeschlagen → 502, reservations/calendar nicht aufgerufen', async () => {
      syncHostexPropertyMock.mockResolvedValueOnce({ success: false, error: 'nope' });
      const r = await post('bootshaus-alte-oder');
      expect(r.status).toBe(502);
      expect(syncHostexReservationsMock).not.toHaveBeenCalled();
      expect(syncHostexCalendarMock).not.toHaveBeenCalled();
      expect(await r.json()).toMatchObject({
        success: false,
        result: { property: { success: false }, reservations: null, calendar: null },
      });
    });

    it('airbnb-mail: 400', async () => {
      const r = await post('firenze-loft');
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain('guesty|hostex');
    });
  });
});

// #1137 PUT /listings/:slug/cleaning-fee
describe('agent-api PUT /listings/:slug/cleaning-fee (#1137)', () => {
  const FARMHOUSE_ID = '686d1e927ae7af00234115ad';
  const AIRBNB2 = { channelSyncStatus: 'IN_PROGRESS', value: { multiplier: 'PER_STAY', formula: 350, valueType: 'FIXED' } };
  const FIN = (value: any = { multiplier: 'PER_STAY', formula: 350, valueType: 'FIXED' }, extra: any = { airbnb2: AIRBNB2 }) => ({
    cleaningFee: { value, lastUpdated: '2025-07-23T10:38:23.230Z', ...extra },
  });
  const put = (slug: string, body: unknown) =>
    fetch(`${base}/api/agent/listings/${slug}/cleaning-fee`, {
      method: 'PUT', headers: KEY, body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function clientMocks() {
    const { guestyClient } = await import('../services/guesty-client.js');
    return guestyClient as unknown as { getListing: any; getListingFinancials: any; updateListingCleaningFee: any };
  }

  beforeEach(async () => {
    const c = await clientMocks();
    c.getListing.mockReset();
    c.getListingFinancials.mockReset().mockResolvedValue(FIN());
    c.updateListingCleaningFee.mockReset().mockResolvedValue(undefined);
    syncListingMock.mockReset().mockResolvedValue({ success: true, listingId: FARMHOUSE_ID });
  });

  it('401 ohne Key', async () => {
    const r = await fetch(`${base}/api/agent/listings/farmhouse/cleaning-fee`, {
      method: 'PUT', body: '{"amount":390}', headers: { 'Content-Type': 'application/json' },
    });
    expect(r.status).toBe(401);
  });

  it('404 bei unbekanntem Slug, ohne Guesty-Zugriff', async () => {
    const c = await clientMocks();
    const r = await put('gibt-es-nicht', { amount: 390 });
    expect(r.status).toBe(404);
    expect(c.getListing).not.toHaveBeenCalled();
    expect(c.updateListingCleaningFee).not.toHaveBeenCalled();
  });

  it.each([
    ['fehlend', {}],
    ['String', { amount: '390' }],
    ['null', { amount: null }],
    ['0', { amount: 0 }],
    ['negativ', { amount: -5 }],
    ['> 1000', { amount: 1000.01 }],
    ['NaN-artig (1e999 → Infinity)', '{"amount":1e999}'],
    ['drei Nachkommastellen', { amount: 390.123 }],
  ])('400 bei ungültigem Betrag: %s', async (_label, body) => {
    const c = await clientMocks();
    const r = await put('farmhouse', body);
    expect(r.status).toBe(400);
    expect(c.updateListingCleaningFee).not.toHaveBeenCalled();
  });

  it('400 bei provider ≠ guesty (Hostex-Objekt)', async () => {
    const c = await clientMocks();
    const r = await put('bootshaus-alte-oder', { amount: 90 });
    expect(r.status).toBe(400);
    expect(c.updateListingCleaningFee).not.toHaveBeenCalled();
  });

  it('Erfolg: previous aus GET vor, current aus GET nach dem Update, Cache wird aufgefrischt', async () => {
    const c = await clientMocks();
    const order: string[] = [];
    c.getListing
      .mockImplementationOnce(async () => { order.push('get-before'); return { prices: { cleaningFee: 350 } }; })
      .mockImplementationOnce(async () => { order.push('get-after'); return { prices: { cleaningFee: 390 } }; });
    c.updateListingCleaningFee.mockImplementation(async () => { order.push('update'); });
    syncListingMock.mockImplementation(async () => { order.push('sync'); return { success: true, listingId: FARMHOUSE_ID }; });

    const r = await put('farmhouse', { amount: 390 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      slug: 'farmhouse', listingId: FARMHOUSE_ID, previous: 350, current: 390,
      channelOverrides: { before: { airbnb2: AIRBNB2 }, after: { airbnb2: AIRBNB2 } },
    });
    expect(c.updateListingCleaningFee).toHaveBeenCalledWith(FARMHOUSE_ID, 390, { valueType: 'FIXED', multiplier: 'PER_STAY' });
    expect(syncListingMock).toHaveBeenCalledWith(FARMHOUSE_ID, true);
    expect(order).toEqual(['get-before', 'update', 'get-after', 'sync']);
  });

  it('current kommt aus Guesty, nicht aus dem Request (Abweichung sichtbar)', async () => {
    const c = await clientMocks();
    c.getListing
      .mockResolvedValueOnce({ prices: { cleaningFee: 350 } })
      .mockResolvedValueOnce({ prices: { cleaningFee: 350 } });
    const r = await put('farmhouse', { amount: 390 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ previous: 350, current: 350 });
  });

  it('Update scheitert → Fehler durchgereicht, kein Cache-Refresh', async () => {
    const c = await clientMocks();
    const { ExternalApiError } = await import('../utils/errors.js');
    c.getListing.mockResolvedValueOnce({ prices: { cleaningFee: 350 } });
    c.updateListingCleaningFee.mockRejectedValueOnce(new ExternalApiError('Guesty down', 502, 'Guesty'));
    const r = await put('farmhouse', { amount: 390 });
    expect(r.status).toBe(502);
    expect(syncListingMock).not.toHaveBeenCalled();
  });

  it('Cache-Refresh scheitert → 200 trotzdem (Guesty-Update ist durch), cacheRefreshed:false', async () => {
    const c = await clientMocks();
    c.getListing
      .mockResolvedValueOnce({ prices: { cleaningFee: 350 } })
      .mockResolvedValueOnce({ prices: { cleaningFee: 390 } });
    syncListingMock.mockResolvedValueOnce({ success: false, listingId: FARMHOUSE_ID, error: 'db' });
    const r = await put('farmhouse', { amount: 390 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ current: 390, cacheRefreshed: false });
  });
});

// #1137 Nachbesserung: Override-Vergleich, PERCENTAGE, multiplier-Übernahme, Fehler im Nach-GET
describe('agent-api PUT /listings/:slug/cleaning-fee — Nachbesserung (#1137)', () => {
  const FARMHOUSE_ID = '686d1e927ae7af00234115ad';
  const VAL = { multiplier: 'PER_STAY', formula: 350, valueType: 'FIXED' };
  const A2 = { channelSyncStatus: 'SYNCED', value: { multiplier: 'PER_STAY', formula: 350, valueType: 'FIXED' } };
  const put = (body: unknown) =>
    fetch(`${base}/api/agent/listings/farmhouse/cleaning-fee`, { method: 'PUT', headers: KEY, body: JSON.stringify(body) });
  async function c() {
    const { guestyClient } = await import('../services/guesty-client.js');
    return guestyClient as unknown as { getListing: any; getListingFinancials: any; updateListingCleaningFee: any };
  }
  beforeEach(async () => {
    const m = await c();
    m.getListing.mockReset().mockResolvedValueOnce({ prices: { cleaningFee: 350 } }).mockResolvedValue({ prices: { cleaningFee: 390 } });
    m.getListingFinancials.mockReset();
    m.updateListingCleaningFee.mockReset().mockResolvedValue({});
    syncListingMock.mockReset().mockResolvedValue({ success: true, listingId: FARMHOUSE_ID });
  });

  it('Overrides gleich (andere Schlüsselreihenfolge, value/lastUpdated ignoriert) → kein overridesChanged', async () => {
    const m = await c();
    m.getListingFinancials
      .mockResolvedValueOnce({ cleaningFee: { value: VAL, lastUpdated: 'a', airbnb2: A2 } })
      .mockResolvedValueOnce({ cleaningFee: { airbnb2: { value: A2.value, channelSyncStatus: 'SYNCED' }, lastUpdated: 'b', value: { ...VAL, formula: 390 } } });
    const body = await (await put({ amount: 390 })).json();
    expect(body.overridesChanged).toBeUndefined();
    expect(body.channelOverrides).toEqual({ before: { airbnb2: A2 }, after: { airbnb2: A2 } });
  });

  it('Override nach dem Update weg → overridesChanged:true, before/after in der Antwort', async () => {
    const m = await c();
    m.getListingFinancials
      .mockResolvedValueOnce({ cleaningFee: { value: VAL, airbnb2: A2 } })
      .mockResolvedValueOnce({ cleaningFee: { value: { ...VAL, formula: 390 } } });
    const r = await put({ amount: 390 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      overridesChanged: true, channelOverrides: { before: { airbnb2: A2 }, after: {} }, current: 390,
    });
  });

  it('Override-Wert geändert → overridesChanged:true', async () => {
    const m = await c();
    m.getListingFinancials
      .mockResolvedValueOnce({ cleaningFee: { value: VAL, airbnb2: A2 } })
      .mockResolvedValueOnce({ cleaningFee: { value: VAL, airbnb2: { ...A2, value: { ...A2.value, formula: 390 } } } });
    expect(await (await put({ amount: 390 })).json()).toMatchObject({ overridesChanged: true });
  });

  it('nur channelSyncStatus wechselt (IN_PROGRESS → SYNCED) → kein overridesChanged, Status bleibt in before/after sichtbar', async () => {
    const m = await c();
    const before = { ...A2, channelSyncStatus: 'IN_PROGRESS' };
    m.getListingFinancials
      .mockResolvedValueOnce({ cleaningFee: { value: VAL, airbnb2: before } })
      .mockResolvedValueOnce({ cleaningFee: { value: { ...VAL, formula: 390 }, airbnb2: A2 } });
    const body = await (await put({ amount: 390 })).json();
    expect(body.overridesChanged).toBeUndefined();
    expect(body.channelOverrides).toEqual({ before: { airbnb2: before }, after: { airbnb2: A2 } });
  });

  it('PERCENTAGE → 409, kein Schreibvorgang', async () => {
    const m = await c();
    m.getListingFinancials.mockResolvedValueOnce({ cleaningFee: { value: { valueType: 'PERCENTAGE', multiplier: 'PER_STAY', formula: 10 } } });
    const r = await put({ amount: 390 });
    expect(r.status).toBe(409);
    expect(m.updateListingCleaningFee).not.toHaveBeenCalled();
  });

  it('abweichender multiplier wird übernommen', async () => {
    const m = await c();
    m.getListingFinancials.mockResolvedValue({ cleaningFee: { value: { valueType: 'FIXED', multiplier: 'PER_NIGHT', formula: 350 } } });
    await put({ amount: 390 });
    expect(m.updateListingCleaningFee).toHaveBeenCalledWith(FARMHOUSE_ID, 390, { valueType: 'FIXED', multiplier: 'PER_NIGHT' });
  });

  it('fehlendes cleaningFee.value → FIXED/PER_STAY', async () => {
    const m = await c();
    m.getListingFinancials.mockResolvedValue({});
    await put({ amount: 390 });
    expect(m.updateListingCleaningFee).toHaveBeenCalledWith(FARMHOUSE_ID, 390, { valueType: 'FIXED', multiplier: 'PER_STAY' });
  });

  it('Nach-GET scheitert nach erfolgtem PUT → 200 written/verifyFailed, current null, Cache-Refresh läuft', async () => {
    const m = await c();
    m.getListingFinancials.mockResolvedValue({ cleaningFee: { value: VAL, airbnb2: A2 } });
    m.getListing.mockReset().mockResolvedValueOnce({ prices: { cleaningFee: 350 } }).mockRejectedValueOnce(new Error('Guesty timeout'));
    const r = await put({ amount: 390 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      previous: 350, current: null, written: true, verifyFailed: true, verifyError: 'Guesty timeout',
      channelOverrides: { before: { airbnb2: A2 }, after: null },
    });
    expect(m.updateListingCleaningFee).toHaveBeenCalledTimes(1);
    expect(syncListingMock).toHaveBeenCalledWith(FARMHOUSE_ID, true);
  });

  it('Vor-GET der Financials scheitert → Fehler, kein Schreibvorgang', async () => {
    const m = await c();
    const { ExternalApiError } = await import('../utils/errors.js');
    m.getListingFinancials.mockRejectedValueOnce(new ExternalApiError('down', 502, 'Guesty'));
    const r = await put({ amount: 390 });
    expect(r.status).toBe(502);
    expect(m.updateListingCleaningFee).not.toHaveBeenCalled();
  });
});
