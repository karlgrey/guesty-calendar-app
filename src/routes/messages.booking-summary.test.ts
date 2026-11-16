import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// #1187: Anfrage-/Buchungsdaten (Zeitraum, Personen, Preis) im Thread-Kopf und als Listen-Badge.
// Muster wie messages.times.test.ts; Resolver läuft echt gegen eine In-Memory-DB.

const getThreadById = vi.fn();
const getThreadsNeedingReply = vi.fn();
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: (...a: unknown[]) => getThreadsNeedingReply(...a),
  getThreadById: (...a: unknown[]) => getThreadById(...a),
  getMessagesByThread: vi.fn().mockReturnValue([]),
  upsertMessage: vi.fn(), getLastMessageSync: vi.fn().mockReturnValue(null), markThreadAiNoReply: vi.fn(),
  markThreadDiscarded: vi.fn(), getThreadsNeedingDraft: vi.fn().mockReturnValue([]), getMessagesSince: vi.fn().mockReturnValue([]),
}));
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: vi.fn(), getDraftById: vi.fn(), getActiveDraftByThread: vi.fn().mockReturnValue(null), discardDraft: vi.fn(),
  claimDraftForSending: vi.fn(), updateDraftBody: vi.fn(), saveEditedDraftBody: vi.fn(), markDraftSent: vi.fn(), markDraftError: vi.fn(),
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

import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import messagesRoutes from './messages.js';

let server: Server; let base: string; let db: Database.Database;
beforeAll(async () => {
  const app = express();
  app.use('/admin/messages', messagesRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const thread = (over: Record<string, unknown> = {}) => ({
  id: 'guesty:a', listing_id: 'L1', source: 'guesty', channel: 'airbnb2', guest_name: 'Lisa', guest_email: null,
  first_message_at: '', last_message_at: '2026-11-16 10:00:00', message_count: 1, reservation_id: null,
  inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null,
  classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
  manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, guests_count INTEGER, adults_count INTEGER,
      children_count INTEGER, infants_count INTEGER, confirmation_code TEXT, source TEXT,
      platform TEXT, currency TEXT, total_price REAL, host_payout REAL
    );
    CREATE TABLE inquiries (
      id INTEGER PRIMARY KEY, inquiry_id TEXT UNIQUE, listing_id TEXT, status TEXT,
      check_in TEXT, check_out TEXT, guest_name TEXT, guests_count INTEGER, source TEXT,
      currency TEXT, total_price REAL, host_payout REAL
    );
  `);
  db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized,
    nights_count, status, guests_count, adults_count, children_count, source, platform, currency, total_price, host_payout)
    VALUES ('R1','L1','2026-12-01T15:00:00.000Z','2026-12-04T12:00:00.000Z','2026-12-01','2026-12-04',3,'confirmed',3,2,1,'airbnb2','airbnb2','EUR',1450,1234)`).run();
  db.prepare(`INSERT INTO inquiries (inquiry_id, listing_id, status, check_in, check_out, guest_name, guests_count, source, currency, total_price, host_payout)
    VALUES ('G1','L1','inquiry','2027-12-31','2028-01-01','Lisa',1,'airbnb2',NULL,NULL,NULL)`).run();
  db.prepare(`INSERT INTO inquiries (inquiry_id, listing_id, status, check_in, check_out, guest_name, guests_count, source, currency, total_price, host_payout)
    VALUES ('G2','L1','inquiry','2027-07-10','2027-07-14','Max',4,'airbnb2','EUR',820.5,700)`).run();
  setDatabase(db);
  getThreadsNeedingReply.mockReturnValue([]);
  getStayTimes.mockReturnValue(null);
});
afterEach(() => { resetDatabase(); db.close(); });

const page = async () => (await fetch(`${base}/admin/messages/guesty%3Aa`)).text();

describe('GET /:threadId — Anfragedaten im Kopf (#1187)', () => {
  it('Buchung mit Preis: Zeitraum, Nächte, Personen mit Aufteilung, Auszahlung + Gastpreis', async () => {
    getThreadById.mockReturnValue(thread({ reservation_id: 'R1', reservation_status: 'confirmed' }));
    const html = await page();
    expect(html).toContain('Buchung (bestätigt)');
    expect(html).toContain('01.12.2026–04.12.2026');
    expect(html).toContain('3 Nächte');
    expect(html).toContain('3 Personen (2 Erw., 1 Kind)');
    expect(html).toContain('Auszahlung 1.234 €');
    expect(html).toContain('Gastpreis 1.450 €');
    expect(html).not.toContain('laut Anfrage');
  });

  it('Anfrage mit Preis (Guesty: reservation_id ohne Zeile fällt auf die Anfrage zurück)', async () => {
    getThreadById.mockReturnValue(thread({ reservation_id: 'G2', inquiry_id: 'G2' }));
    const html = await page();
    expect(html).toContain('<strong>Anfrage</strong> · 10.07.2027–14.07.2027 · 4 Nächte · 4 Personen (laut Anfrage)');
    expect(html).toContain('Auszahlung 700 €');
    expect(html).toContain('Gastpreis 820,50 €');
  });

  it('Anfrage ohne Preis (Lisa-Fall): Kopfzeile wie in der Akzeptanz, „Preis unbekannt"', async () => {
    getThreadById.mockReturnValue(thread({ reservation_id: 'G1', inquiry_id: 'G1' }));
    const html = await page();
    expect(html).toContain('<strong>Anfrage</strong> · 31.12.2027–01.01.2028 · 1 Nacht · 1 Person (laut Anfrage) · Preis unbekannt');
  });

  it('ohne Verknüpfung: Hinweis', async () => {
    getThreadById.mockReturnValue(thread());
    expect(await page()).toContain('keine Buchung/Anfrage verknüpft');
  });

  it('DB-Fehler lässt die Seite nicht abstürzen', async () => {
    resetDatabase();
    getThreadById.mockReturnValue(thread({ reservation_id: 'R1' }));
    const r = await fetch(`${base}/admin/messages/guesty%3Aa`);
    expect(r.status).toBe(200);
    setDatabase(db);
  });
});

describe('GET / — Listen-Badge (#1187)', () => {
  it('zeigt kompaktes Badge ohne Preis, ohne Verknüpfung kein Badge', async () => {
    getThreadsNeedingReply.mockReturnValue([
      thread({ id: 'guesty:a', reservation_id: 'G1', inquiry_id: 'G1' }),
      thread({ id: 'guesty:b', guest_name: 'Bob', reservation_id: 'R1' }),
      thread({ id: 'guesty:c', guest_name: 'Cleo' }),
    ]);
    const html = await (await fetch(`${base}/admin/messages`)).text();
    expect(html).toContain('31.12.–01.01. · 1 P.');
    expect(html).toContain('01.12.–04.12. · 3 P.');
    expect(html).not.toContain('Auszahlung');
    expect(html.match(/booking-badge/g)?.length).toBe(2);
  });
});
