import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';

const m = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listConversationPosts: vi.fn(),
  counters: { total: 0, conversationList: 0, conversationPosts: 0, conversationGet: 0, other: 0, retries: 0, rateLimited429: 0 },
  info: vi.fn(),
}));
vi.mock('../services/guesty-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/guesty-client.js')>('../services/guesty-client.js');
  return {
    ...actual,
    guestyClient: {
      listConversations: m.listConversations,
      listConversationPosts: m.listConversationPosts,
      getRequestCounters: () => ({ ...m.counters }),
    },
  };
});
vi.mock('../utils/logger.js', () => ({
  default: { info: m.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  shouldDeepFetchConversation,
  isLocalThreadInWindow,
  fetchConversationsIncremental,
  fetchAllConversations,
  fetchAllConversationsWithStats,
  syncGuestyMessagesForProperty,
  INCREMENTAL_ACTIVE_WINDOW_DAYS,
  STAY_GRACE_DAYS,
} from './sync-guesty-messages.js';
import type { PropertyConfig } from '../config/properties.js';

const NOW = new Date('2026-07-07T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000).toISOString();
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 24 * 3600 * 1000).toISOString();

function conv(checkOut?: string): any {
  return { meta: { reservations: checkOut ? [{ checkOut }] : [] } };
}

describe('Fensterkonstanten', () => {
  it('Webhook ist Primärweg: kleine Fenster', () => {
    expect(INCREMENTAL_ACTIVE_WINDOW_DAYS).toBe(7);
    expect(STAY_GRACE_DAYS).toBe(3);
  });
});

describe('shouldDeepFetchConversation', () => {
  it('always fetches unknown conversations', () => {
    expect(shouldDeepFetchConversation(conv(), null, NOW)).toBe(true);
  });

  it('Aktivitätsfenster: 6 Tage drin, 8 Tage draußen', () => {
    expect(shouldDeepFetchConversation(conv(daysAgo(300)), { last_message_at: daysAgo(6) }, NOW)).toBe(true);
    expect(shouldDeepFetchConversation(conv(daysAgo(300)), { last_message_at: daysAgo(8) }, NOW)).toBe(false);
  });

  it('Aufenthalt: Check-out vor 2 Tagen drin, vor 4 Tagen draußen, künftig drin', () => {
    const stale = { last_message_at: daysAgo(200) };
    expect(shouldDeepFetchConversation(conv(daysAgo(2)), stale, NOW)).toBe(true);
    expect(shouldDeepFetchConversation(conv(daysAgo(4)), stale, NOW)).toBe(false);
    expect(shouldDeepFetchConversation(conv(daysAhead(60)), stale, NOW)).toBe(true);
  });

  it('keine Reservierungsdaten + altes Thread → nicht holen', () => {
    expect(shouldDeepFetchConversation(conv(), { last_message_at: daysAgo(30) }, NOW)).toBe(false);
  });
});

describe('isLocalThreadInWindow', () => {
  const t = (last: string, rawMeta: string | null = null) => ({ last_message_at: last, raw_meta: rawMeta });
  it('last_message_at im Aktivitätsfenster', () => {
    expect(isLocalThreadInWindow(t(daysAgo(6)), null, NOW)).toBe(true);
    expect(isLocalThreadInWindow(t(daysAgo(8)), null, NOW)).toBe(false);
  });
  it('raw_meta.checkOuts: 2 Tage drin, 4 Tage draußen, künftig drin', () => {
    const meta = (d: string) => JSON.stringify({ checkOuts: [d] });
    expect(isLocalThreadInWindow(t(daysAgo(100), meta(daysAgo(2))), null, NOW)).toBe(true);
    expect(isLocalThreadInWindow(t(daysAgo(100), meta(daysAgo(4))), null, NOW)).toBe(false);
    expect(isLocalThreadInWindow(t(daysAgo(100), meta(daysAhead(30))), null, NOW)).toBe(true);
  });
  it('reservationCheckOut als Fallback', () => {
    expect(isLocalThreadInWindow(t(daysAgo(100)), daysAhead(5), NOW)).toBe(true);
    expect(isLocalThreadInWindow(t(daysAgo(100)), daysAgo(4), NOW)).toBe(false);
    expect(isLocalThreadInWindow(t(daysAgo(100)), '2026-07-06', NOW)).toBe(true);
  });
  it('kaputtes/fehlendes raw_meta und Müll-Daten werfen nicht', () => {
    expect(isLocalThreadInWindow(t(daysAgo(100), '{kaputt'), null, NOW)).toBe(false);
    expect(isLocalThreadInWindow(t(daysAgo(100), JSON.stringify({ checkOuts: [null, 5, 'x'] })), 'nope', NOW)).toBe(false);
    expect(isLocalThreadInWindow(t('kaputt'), null, NOW)).toBe(false);
  });
});

function page(ids: Array<[string, string | undefined]>, nextCursor?: string) {
  return { conversations: ids.map(([_id, createdAt]) => ({ _id, createdAt })), nextCursor };
}

describe('fetchConversationsIncremental', () => {
  beforeEach(() => m.listConversations.mockReset());
  const known = (ids: string[]) => (id: string) => ids.includes(id);

  it('bricht nach der Seite ab, wenn sie alte Konversationen enthält und alle alten bekannt sind', async () => {
    m.listConversations.mockResolvedValueOnce(page([['n1', daysAgo(1)], ['o1', daysAgo(20)], ['o2', daysAgo(30)]], 'c2'));
    const r = await fetchConversationsIncremental({ isKnown: known(['o1', 'o2']), now: NOW });
    expect(m.listConversations).toHaveBeenCalledTimes(1);
    expect(r.pages).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.conversations.map((c) => c._id)).toEqual(['n1', 'o1', 'o2']);
  });

  it('blättert weiter, wenn eine alte Konversation unbekannt ist', async () => {
    m.listConversations
      .mockResolvedValueOnce(page([['o1', daysAgo(20)], ['x', daysAgo(25)]], 'c2'))
      .mockResolvedValueOnce(page([['o3', daysAgo(40)]], 'c3'));
    const r = await fetchConversationsIncremental({ isKnown: known(['o1', 'o3']), now: NOW });
    expect(m.listConversations).toHaveBeenCalledTimes(2);
    expect(m.listConversations.mock.calls[1][0]).toMatchObject({ limit: 100, cursorAfter: 'c2' });
    expect(r.pages).toBe(2);
    expect(r.complete).toBe(false);
  });

  it('blättert weiter, solange die Seite nur junge Konversationen enthält', async () => {
    m.listConversations
      .mockResolvedValueOnce(page([['n1', daysAgo(1)], ['n2', daysAgo(2)]], 'c2'))
      .mockResolvedValueOnce(page([['n3', daysAgo(3)], ['o1', daysAgo(10)]], 'c3'));
    const r = await fetchConversationsIncremental({ isKnown: known(['o1']), now: NOW });
    expect(m.listConversations).toHaveBeenCalledTimes(2);
    expect(r.conversations).toHaveLength(4);
  });

  it('fehlendes/unparsebares createdAt zählt nicht als alt', async () => {
    m.listConversations
      .mockResolvedValueOnce(page([['a', undefined], ['b', 'kaputt']], 'c2'))
      .mockResolvedValueOnce(page([['o1', daysAgo(20)]]));
    const r = await fetchConversationsIncremental({ isKnown: known(['o1']), now: NOW });
    expect(m.listConversations).toHaveBeenCalledTimes(2);
    expect(r.complete).toBe(true);
  });

  it('Ende bei leerem Cursor → complete=true', async () => {
    m.listConversations.mockResolvedValueOnce(page([['n1', daysAgo(1)]]));
    const r = await fetchConversationsIncremental({ isKnown: () => true, now: NOW });
    expect(r).toMatchObject({ pages: 1, complete: true });
  });

  it('Seitenlimit 50 → stoppt, complete=false', async () => {
    m.listConversations.mockResolvedValue(page([['n1', daysAgo(1)]], 'next'));
    const r = await fetchConversationsIncremental({ isKnown: () => true, now: NOW });
    expect(r.complete).toBe(false);
    expect(r.pages).toBe(51);
    expect(m.listConversations).toHaveBeenCalledTimes(51);
  });

  it('Default-isKnown liest die lokale DB (guesty:<id>)', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE message_threads (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
      reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT, conversion_category TEXT, classification_confidence REAL,
      classification_keywords TEXT, raw_meta TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at) VALUES ('guesty:o1','L','guesty','airbnb','t','t','t')`).run();
    setDatabase(db);
    try {
      m.listConversations.mockResolvedValueOnce(page([['o1', daysAgo(20)]], 'c2'));
      const r = await fetchConversationsIncremental({ now: NOW });
      expect(r.pages).toBe(1);
    } finally { resetDatabase(); db.close(); }
  });
});

describe('fetchAllConversations(WithStats)', () => {
  beforeEach(() => m.listConversations.mockReset());
  it('liefert alles + Seitenzahl, Signatur von fetchAllConversations unverändert', async () => {
    m.listConversations.mockResolvedValueOnce(page([['a', daysAgo(1)]], 'c2')).mockResolvedValueOnce(page([['b', daysAgo(2)]]));
    const r = await fetchAllConversationsWithStats();
    expect(r.pages).toBe(2);
    expect(r.conversations).toHaveLength(2);
    m.listConversations.mockResolvedValueOnce(page([['a', daysAgo(1)]]));
    expect(await fetchAllConversations()).toHaveLength(1);
  });
});

// ---- Sync mit Test-DB ----
let db: Database.Database;
const prop = { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1' } as unknown as PropertyConfig;

function setupDb() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_threads (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
      conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
      raw_meta TEXT, manually_categorized INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL,
      from_name TEXT, from_address TEXT, to_address TEXT, subject TEXT, body TEXT NOT NULL, body_html TEXT,
      source TEXT NOT NULL, raw_meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE reservations (id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT, check_in TEXT, check_out TEXT, status TEXT, source TEXT);
  `);
  setDatabase(db);
}
function insThread(id: string, last: string, over: Record<string, any> = {}) {
  db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,guest_name,first_message_at,last_message_at,message_count,reservation_id,inquiry_id,reservation_status,raw_meta,last_synced_at)
    VALUES (@id,@listing_id,'guesty',@channel,@guest_name,@first,@last,1,@res,@res,@status,@raw,'t')`).run({
    id, listing_id: 'G1', channel: 'airbnb', guest_name: 'Gast', first: last, last, res: 'R-' + id, status: 'confirmed', raw: null, ...over,
  });
}
const apiConv = (id: string, createdAt: string, checkOut?: string) => ({
  _id: id, createdAt, meta: { guest: { fullName: 'Neu' }, reservations: [{ _id: 'R' + id, listing: { _id: 'G1' }, source: 'airbnb2', status: 'confirmed', ...(checkOut ? { checkOut } : {}) }] },
});
const post = (id: string, at: string) => ({ _id: id, createdAt: at, sentBy: 'guest', body: 'GEHEIMER TEXT', module: { type: 'airbnb2' } });

describe('syncGuestyMessagesForProperty', () => {
  beforeEach(() => { setupDb(); m.listConversationPosts.mockReset(); m.info.mockReset(); Object.assign(m.counters, { total: 0, conversationPosts: 0 }); vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); resetDatabase(); db.close(); });

  it('schreibt checkOuts ins raw_meta (nur gültige Strings), bestehende Felder bleiben', async () => {
    const c: any = apiConv('c1', daysAgo(1), daysAhead(5));
    c.state = { read: false }; c.priority = 'p';
    c.meta.reservations.push({ _id: 'R2', listing: { _id: 'G1' }, checkOut: daysAgo(40) }, { _id: 'R3', listing: { _id: 'G1' }, checkOut: 5 });
    m.listConversationPosts.mockResolvedValue([post('p1', daysAgo(1))]);
    await syncGuestyMessagesForProperty(prop, [c], { deep: true });
    const raw = JSON.parse((db.prepare(`SELECT raw_meta FROM message_threads WHERE id='guesty:c1'`).get() as any).raw_meta);
    expect(raw.checkOuts).toEqual([daysAhead(5), daysAgo(40)]);
    expect(raw).toMatchObject({ priority: 'p', state: { read: false } });
  });

  it('partialList: holt Fenster-Threads aus der Liste UND lokale Fenster-Threads, nicht bekannte außerhalb', async () => {
    insThread('guesty:inList', daysAgo(1));
    insThread('guesty:localActive', daysAgo(2), { guest_name: 'Lokal', raw: JSON.stringify({ priority: 'x' }) });
    insThread('guesty:localStay', daysAgo(100), { raw: JSON.stringify({ checkOuts: [daysAhead(3)] }) });
    insThread('guesty:localOld', daysAgo(100), { raw: JSON.stringify({ checkOuts: [daysAgo(50)] }) });
    insThread('guesty:otherListing', daysAgo(1), { listing_id: 'G2' });
    m.listConversationPosts.mockImplementation(async (id: string) => [post('p-' + id, daysAgo(1))]);
    const list = [apiConv('inList', daysAgo(30)), apiConv('brandNew', daysAgo(0.5))];
    const res = await syncGuestyMessagesForProperty(prop, list, { deep: false, partialList: true });
    const fetched = m.listConversationPosts.mock.calls.map((c) => c[0]).sort();
    expect(fetched).toEqual(['brandNew', 'inList', 'localActive', 'localStay']);
    expect(res.success).toBe(true);
    // lokaler Thread: Zeilenwerte erhalten, Zähler neu
    const t = db.prepare(`SELECT * FROM message_threads WHERE id='guesty:localActive'`).get() as any;
    expect(t.guest_name).toBe('Lokal');
    expect(t.raw_meta).toBe(JSON.stringify({ priority: 'x' }));
    expect(t.message_count).toBe(1);
    expect(t.last_message_at).toBe(daysAgo(1));
    expect((db.prepare(`SELECT COUNT(*) n FROM messages WHERE thread_id='guesty:localActive'`).get() as any).n).toBe(1);
    // bekannter, außerhalb des Fensters, nicht in der Liste
    expect((db.prepare(`SELECT COUNT(*) n FROM messages WHERE thread_id='guesty:localOld'`).get() as any).n).toBe(0);
  });

  it('ohne partialList werden lokale Threads nicht zusätzlich geholt', async () => {
    insThread('guesty:localActive', daysAgo(2));
    m.listConversationPosts.mockResolvedValue([]);
    await syncGuestyMessagesForProperty(prop, [apiConv('inList', daysAgo(1))], { deep: false });
    expect(m.listConversationPosts.mock.calls.map((c) => c[0])).toEqual(['inList']);
  });

  it('excludeConvIds: weder Listen- noch lokale Threads werden nochmal geholt', async () => {
    insThread('guesty:localActive', daysAgo(2));
    m.listConversationPosts.mockResolvedValue([]);
    await syncGuestyMessagesForProperty(prop, [apiConv('inList', daysAgo(1)), apiConv('other', daysAgo(1))], {
      deep: false, partialList: true, excludeConvIds: new Set(['inList', 'localActive']),
    });
    expect(m.listConversationPosts.mock.calls.map((c) => c[0])).toEqual(['other']);
  });

  it('Reservierungs-Check-out aus der reservations-Tabelle zählt für lokale Threads', async () => {
    insThread('guesty:viaRes', daysAgo(100), { res: 'RES1' });
    db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_out) VALUES ('RES1','G1',?)`).run(daysAhead(2));
    m.listConversationPosts.mockResolvedValue([]);
    await syncGuestyMessagesForProperty(prop, [], { deep: false, partialList: true });
    expect(m.listConversationPosts.mock.calls.map((c) => c[0])).toEqual(['viaRes']);
  });

  it('Log enthält postsFetched, localWindowFetched, guestyRequests — keine Nachrichtentexte', async () => {
    insThread('guesty:localActive', daysAgo(2));
    m.listConversationPosts.mockImplementation(async (id: string) => {
      m.counters.total += 1; m.counters.conversationPosts += 1;
      return [post('p-' + id, daysAgo(1))];
    });
    await syncGuestyMessagesForProperty(prop, [apiConv('inList', daysAgo(1))], { deep: false, partialList: true });
    const call = m.info.mock.calls.find((c) => c[1] === 'Guesty messages: sync completed');
    expect(call).toBeTruthy();
    expect(call![0]).toMatchObject({ postsFetched: 2, localWindowFetched: 1 });
    expect(call![0].guestyRequests).toMatchObject({ total: 2, conversationPosts: 2 });
    expect(JSON.stringify(m.info.mock.calls)).not.toContain('GEHEIMER TEXT');
  });
});
