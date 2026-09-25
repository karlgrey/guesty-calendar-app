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
  releaseOfferReservation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/document-service.js', () => ({
  createOrGetDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fake'), isNew: false,
  }),
  refreshDocument: vi.fn().mockResolvedValue({
    document: { documentNumber: 'A-2026-0042' }, pdf: Buffer.from('%PDF-fresh'), isNew: false,
  }),
}));
vi.mock('../services/guesty-client.js', () => ({
  guestyClient: {
    getReservation: vi.fn().mockResolvedValue({ _id: 'res-1', status: 'reserved' }),
    updateGuest: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../repositories/draft-repository.js', () => ({
  getAwaitingDrafts: vi.fn().mockReturnValue([{
    id: 'd1', thread_id: 'hostex:a', provider: 'hostex', status: 'pending', created_at: '2026-09-19 12:00:00',
    reason: 'Kategorie Sonderwunsch — nie automatisch', guest_name: 'Anna', listing_id: 'L1', source: 'hostex',
    last_guest_message: 'Könnten wir schon um 11 Uhr rein? Wir sind früh da.\nDanke!',
  }, {
    // #697: Buchungsanfrage-Draft (Fall Anika) — auto_decision='auto', live gesendet, mit Frist.
    id: 'd2', thread_id: 'guesty:b', provider: 'guesty', status: 'sent', created_at: '2026-09-21 20:35:10',
    reason: 'Rückfrage automatisch gesendet — Entscheidung in Airbnb nach Gast-Antwort',
    guest_name: 'Anika', listing_id: 'L1', source: 'guesty',
    last_guest_message: 'Ich würde gern für ein Event buchen.',
    smarttasks_task_id: 701, request_kind: 'request_to_book', platform_deadline_at: '2026-09-22T20:35:04.000Z',
    auto_category: 'buchungsanfrage', auto_decision: 'auto', auto_mode: 'live',
  }]),
  getAutoSendStats: vi.fn().mockReturnValue({ autoSent: 2, waited: 3, shadowWouldAuto: 10, shadowUnchanged: 9, shadowChanged: 1, shadowDiscarded: 0 }),
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

import agentApiRoutes from './agent-api.js';

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
        reason: 'Rückfrage automatisch gesendet — Entscheidung in Airbnb nach Gast-Antwort',
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
});
