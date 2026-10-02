import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// #799: Admin-Formular „Zeit-Abweichung" in der Thread-Ansicht — Route-Seite (HTML + POST-Weiterleitung);
// die Logik steckt im gemeinsamen Service (stay-times-service.test.ts). Muster wie messages.stale-draft.test.ts.

const getThreadById = vi.fn();
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: vi.fn().mockReturnValue([]),
  getThreadById: (...a: unknown[]) => getThreadById(...a),
  getMessagesByThread: vi.fn().mockReturnValue([]),
  upsertMessage: vi.fn(), getLastMessageSync: vi.fn().mockReturnValue(null), markThreadAiNoReply: vi.fn(),
  markThreadDiscarded: vi.fn(), getThreadsNeedingDraft: vi.fn().mockReturnValue([]), getMessagesSince: vi.fn().mockReturnValue([]),
}));
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: vi.fn(), getDraftById: vi.fn(), getActiveDraftByThread: vi.fn().mockReturnValue(null), discardDraft: vi.fn(),
  claimDraftForSending: vi.fn(), updateDraftBody: vi.fn(), markDraftSent: vi.fn(), markDraftError: vi.fn(),
  setSentBodyChanged: vi.fn(), getAutoSendStats: vi.fn(), countAutoSentSince: vi.fn().mockReturnValue(0),
  listAutoDecisions: vi.fn().mockReturnValue([]), getLastSentDraftByThread: vi.fn().mockReturnValue(null),
  threadHasFailedSend: vi.fn().mockReturnValue(false), releaseAutoSendForThread: vi.fn(),
}));
vi.mock('../repositories/feedback-repository.js', () => ({
  createFeedback: vi.fn(), createSuggestion: vi.fn(), countPendingSuggestions: vi.fn().mockReturnValue(0),
}));
vi.mock('../utils/thread-property.js', () => ({
  getPropertyForThread: vi.fn().mockReturnValue(undefined), propertyForBadge: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../services/stale-draft-regen.js', () => ({
  regenerateStaleDraftIfNeeded: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'test' }),
}));
const getStayTimes = vi.fn();
const setStayTimes = vi.fn();
const deleteStayTimes = vi.fn();
vi.mock('../services/stay-times-service.js', () => ({
  getStayTimes: (...a: unknown[]) => getStayTimes(...a),
  setStayTimes: (...a: unknown[]) => setStayTimes(...a),
  deleteStayTimes: (...a: unknown[]) => deleteStayTimes(...a),
}));

import messagesRoutes from './messages.js';
import { ConflictError } from '../utils/errors.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/admin/messages', messagesRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const thread = (over: Record<string, unknown> = {}) => ({
  id: 'guesty:a', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Anna', guest_email: null,
  first_message_at: '', last_message_at: '2026-09-25 10:00:00', message_count: 1, reservation_id: 'res-1',
  inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null,
  classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
  manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '', ...over,
});
const view = (over: Record<string, unknown> = {}, override: unknown = null) => ({
  reservationId: 'res-1', provider: 'guesty', propertySlug: 'farmhouse', blocksNextDay: true,
  checkIn: '2026-12-01', checkOut: '2026-12-03', status: 'confirmed',
  times: {
    effectiveArrival: '08:00', arrivalSource: 'default', effectiveDeparture: override ? '18:00' : '12:00', departureSource: override ? 'override' : 'default',
    providerArrival: null, providerDeparture: null, listingDefaultArrival: '08:00', listingDefaultDeparture: '12:00', override,
  },
  ...over,
});
const OVERRIDE = { plannedArrival: null, plannedDeparture: '18:00', blockNextDay: true, note: 'Chat <b>', source: 'agent', updatedAt: 'x' };
const post = (path: string, body: Record<string, string> = {}) =>
  fetch(`${base}/admin/messages/guesty%3Aa/${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getThreadById.mockReturnValue(thread());
  getStayTimes.mockReturnValue(view());
  setStayTimes.mockResolvedValue({ ok: true, calendarSynced: true, nextDayBlock: { applied: true, method: 'reservation' } });
  deleteStayTimes.mockResolvedValue({ ok: true, calendarSynced: true });
});

describe('GET /:threadId — Zeit-Abweichung', () => {
  it('zeigt Formular mit effektiven Zeiten, Checkbox (Flag-Objekt), ohne Löschen-Button ohne Override', async () => {
    const html = await (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();
    expect(getStayTimes).toHaveBeenCalledWith('res-1');
    expect(html).toContain('Zeit-Abweichung');
    expect(html).toContain('name="plannedArrival"');
    expect(html).toContain('name="plannedDeparture"');
    expect(html).toContain('name="blockNextDay"');
    expect(html).toContain('keine Abweichung');
    expect(html).not.toContain('/times/delete');
  });

  it('mit Override: Werte vorbelegt, Löschen-Button, Notiz escaped, Block-Checkbox angehakt', async () => {
    getStayTimes.mockReturnValue(view({}, OVERRIDE));
    const html = await (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();
    expect(html).toContain('value="18:00"');
    expect(html).toContain('Abweichung aktiv');
    expect(html).toContain('/admin/messages/guesty%3Aa/times/delete');
    expect(html).toContain('Chat &lt;b&gt;');
    expect(html).toMatch(/name="blockNextDay"[^>]*checked/);
  });

  it('Objekt ohne Flag: keine Checkbox', async () => {
    getStayTimes.mockReturnValue(view({ blocksNextDay: false }));
    const html = await (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();
    expect(html).not.toContain('name="blockNextDay"');
  });

  it('Thread ohne reservation_id oder ohne lokale Zeile: kein Formular', async () => {
    getThreadById.mockReturnValue(thread({ reservation_id: null }));
    let html = await (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();
    expect(html).not.toContain('Zeit-Abweichung');
    expect(getStayTimes).not.toHaveBeenCalled();
    getThreadById.mockReturnValue(thread());
    getStayTimes.mockReturnValue(null);
    html = await (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();
    expect(html).not.toContain('Zeit-Abweichung');
  });

  it('Lookup-Fehler lässt die Seite nicht abstürzen', async () => {
    getStayTimes.mockImplementation(() => { throw new Error('db'); });
    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
  });

  it('zeigt Fehler- und Erfolgshinweise aus der Query (escaped)', async () => {
    let html = await (await fetch(`${base}/admin/messages/guesty%3Aa?timeserr=${encodeURIComponent('Kaputt <x>')}`)).text();
    expect(html).toContain('Kaputt &lt;x&gt;');
    html = await (await fetch(`${base}/admin/messages/guesty%3Aa?times=saved&calsync=1`)).text();
    expect(html).toContain('Zeit-Abweichung gespeichert.');
  });
});

describe('POST /:threadId/times', () => {
  it('speichert über den Service (source admin), leere Felder = null, Checkbox -> true', async () => {
    const r = await post('times', { plannedArrival: '', plannedDeparture: '18:00', blockNextDay: '1', note: ' Chat ' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/messages/guesty%3Aa?times=saved&calsync=1');
    expect(setStayTimes).toHaveBeenCalledWith('res-1', { plannedArrival: null, plannedDeparture: '18:00', note: 'Chat', blockNextDay: true }, 'admin');
  });

  it('Checkbox nicht angehakt -> blockNextDay false (Rücknahme)', async () => {
    await post('times', { plannedDeparture: '18:00' });
    expect(setStayTimes.mock.calls[0][1]).toMatchObject({ blockNextDay: false });
  });

  it('Objekt ohne Flag: blockNextDay wird gar nicht gesendet', async () => {
    getStayTimes.mockReturnValue(view({ blocksNextDay: false }));
    await post('times', { plannedDeparture: '18:00', blockNextDay: '1' });
    expect(setStayTimes.mock.calls[0][1]).not.toHaveProperty('blockNextDay');
  });

  it('alles leer -> Hinweis statt leerem Override', async () => {
    const r = await post('times', { plannedArrival: '', plannedDeparture: '', note: '' });
    expect(r.headers.get('location')).toContain('timeserr=');
    expect(setStayTimes).not.toHaveBeenCalled();
  });

  it('Service-Fehler (409) -> Weiterleitung mit timeserr', async () => {
    setStayTimes.mockRejectedValueOnce(new ConflictError("Reservierung im Status 'canceled'"));
    const r = await post('times', { plannedDeparture: '18:00' });
    const loc = new URL(r.headers.get('location')!, 'http://x');
    expect(loc.searchParams.get('timeserr')).toContain("Status 'canceled'");
  });

  it('Guesty-Block-Fehler -> Override gespeichert, Hinweis mit Grund', async () => {
    setStayTimes.mockResolvedValueOnce({ ok: true, calendarSynced: true, blockError: { message: 'dates blocked' } });
    const r = await post('times', { plannedDeparture: '18:00', blockNextDay: '1' });
    const loc = new URL(r.headers.get('location')!, 'http://x');
    expect(loc.searchParams.get('timeserr')).toMatch(/Gespeichert, aber Folgetag-Block.*dates blocked/);
  });

  it('Thread ohne reservation_id -> 400; unbekannter Thread -> 404', async () => {
    getThreadById.mockReturnValue(thread({ reservation_id: null }));
    expect((await post('times', { plannedDeparture: '18:00' })).status).toBe(400);
    getThreadById.mockReturnValue(null);
    expect((await post('times', { plannedDeparture: '18:00' })).status).toBe(404);
  });
});

describe('POST /:threadId/times/delete', () => {
  it('löscht über den Service und leitet zurück', async () => {
    const r = await post('times/delete');
    expect(deleteStayTimes).toHaveBeenCalledWith('res-1');
    expect(r.headers.get('location')).toBe('/admin/messages/guesty%3Aa?times=deleted&calsync=1');
  });
  it('Unblock-Fehler -> Hinweis, Abweichung bleibt', async () => {
    deleteStayTimes.mockResolvedValueOnce({ ok: true, blockError: { message: 'x' } });
    const r = await post('times/delete');
    expect(new URL(r.headers.get('location')!, 'http://x').searchParams.get('timeserr')).toMatch(/bleibt bestehen/);
  });
});
