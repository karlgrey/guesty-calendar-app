import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { handleGuestyInbound, WEBHOOK_LOCK_WAIT_MS, type InboundDeps } from './handle-guesty-inbound.js';
import { messageSyncLock, resetMessageSyncLockForTests, resetPendingGuestyConversationsForTests, takePendingGuestyConversations, pendingGuestyConversationCount } from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { prefetchInquiryForThread } from './inquiry-prefetch.js';
import { upsertGuestyInquiries } from './sync-inquiries.js';
import { getReservationById, getInquiryById } from '../repositories/reservation-repository.js';
import { buildBookingContext, resolveBookingPeriod, resolveThreadBookingSummary } from '../services/booking-context.js';
import { buildBookingTaskTitle } from '../services/booking-request-task-service.js';
import type { MessageThread } from '../types/messages.js';

const props = [{ slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1' }, { slug: 'u19', provider: 'guesty', guestyPropertyId: 'G2' }] as PropertyConfig[];
const conv = { _id: 'c1', meta: { reservations: [{ listing: { _id: 'G2' } }] } };
function deps(over: Partial<InboundDeps> = {}): InboundDeps {
  return { getProperties: () => props, getConversation: vi.fn().mockResolvedValue(conv), syncGuesty: vi.fn().mockResolvedValue(undefined), generateDrafts: vi.fn().mockResolvedValue(undefined), prefetchInquiry: vi.fn().mockResolvedValue('exists'), ...over };
}

describe('handleGuestyInbound', () => {
  beforeEach(() => { resetMessageSyncLockForTests(); resetPendingGuestyConversationsForTests(); });

  // Fix-Runde 1 (Important #1): das Payload wird NIE direkt persistiert (Spec 3.1) — die
  // Konversation kommt immer per getConversation, selbst wenn das Payload schon Listing-Info
  // trägt. Sonst würde ein unvollständiges Payload z.B. guest_name in der DB löschen.
  it('lädt die Konversation immer per API nach — auch wenn das Payload selbst schon Listing-Info trägt —, synct nur das passende Objekt, dann Kette für genau diesen Thread', async () => {
    const d = deps();
    // Payload trägt (untypisch, aber laut Guesty-Doku möglich) bereits eigene Listing-Info —
    // die muss ignoriert werden: sonst würde ein unvollständiges Payload z.B. guest_name löschen.
    await handleGuestyInbound({ event: 'x', conversation: conv, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).toHaveBeenCalledWith('c1');
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [conv]);
    expect(d.generateDrafts).toHaveBeenCalledWith(props[1], ['guesty:c1']);
    // #1234: Einzelabruf für genau diesen Thread, nach dem Sync und vor der Draft-Gen
    expect(d.prefetchInquiry).toHaveBeenCalledTimes(1);
    expect(d.prefetchInquiry).toHaveBeenCalledWith('guesty:c1');
    const order = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(order(d.syncGuesty)).toBeLessThan(order(d.prefetchInquiry));
    expect(order(d.prefetchInquiry)).toBeLessThan(order(d.generateDrafts));
  });
  it('kein Objekt passt → nichts, kein Fehler', async () => {
    const d = deps({ getConversation: vi.fn().mockResolvedValue({ _id: 'c1', meta: { reservations: [{ listing: { _id: 'ZZ' } }] } }) });
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.syncGuesty).not.toHaveBeenCalled();
  });

  describe('Lock', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('Lock vorbelegt (ETL) → syncGuesty wird nicht aufgerufen, kein Fehler', async () => {
      messageSyncLock.tryAcquire('etl');
      const d = deps();
      const resultPromise = handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
      await vi.advanceTimersByTimeAsync(WEBHOOK_LOCK_WAIT_MS + 1_000);
      await expect(resultPromise).resolves.toBeUndefined();
      expect(d.syncGuesty).not.toHaveBeenCalled();
      expect(messageSyncLock.holder).toBe('etl');
    });

    it('Lock-Wartezeit 120 s; bei Verlust wird die geladene conv vorgemerkt', async () => {
      expect(WEBHOOK_LOCK_WAIT_MS).toBe(120_000);
      messageSyncLock.tryAcquire('message-loop');
      const d = deps();
      const resultPromise = handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
      await vi.advanceTimersByTimeAsync(WEBHOOK_LOCK_WAIT_MS + 1_000);
      await resultPromise;
      expect(d.syncGuesty).not.toHaveBeenCalled();
      expect(d.generateDrafts).not.toHaveBeenCalled();
      expect(d.prefetchInquiry).not.toHaveBeenCalled();
      expect(pendingGuestyConversationCount()).toBe(1);
      expect(takePendingGuestyConversations()).toEqual([conv]);
    });

    it('syncGuesty wirft → Lock wird trotzdem freigegeben', async () => {
      const d = deps({ syncGuesty: vi.fn().mockRejectedValue(new Error('boom')) });
      await expect(handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d)).rejects.toThrow('boom');
      expect(messageSyncLock.holder).toBeNull();
    });
  });

  // #1234 (Fall Daniel, 17.11.2026): frische Anfrage — der Thread ist verknüpft, aber die
  // inquiries-Zeile entstand erst beim nächsten Stunden-ETL. Der Eingang holt sie jetzt per
  // Einzelabruf, BEVOR Entwurf, Auto-Send-Gate und Buchungsanfrage-Task laufen.
  describe('Einzelabruf der Anfragedaten (#1234)', () => {
    let db: Database.Database;
    const RES_ID = '6afc0c9b749197da410ebcd6';
    const fh = { slug: 'farmhouse', name: 'Farmhouse', shortCode: 'FH', provider: 'guesty', guestyPropertyId: 'G2' } as PropertyConfig;
    const daniel: MessageThread = {
      id: 'guesty:c1', listing_id: 'G2', source: 'guesty', channel: 'airbnb2', guest_name: 'Daniel Muster',
      guest_email: null, first_message_at: '', last_message_at: '', message_count: 1,
      reservation_id: RES_ID, inquiry_id: RES_ID, reservation_status: 'inquiry', conversion_category: null,
      classification_confidence: null, classification_keywords: null, classification_reasoning: null,
      raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null,
      ai_no_reply_at: null, last_synced_at: '',
    };
    const guestyReservation = {
      _id: RES_ID, listingId: 'G2', status: 'inquiry',
      checkIn: '2026-11-20T14:00:00.000Z', checkOut: '2026-11-22T09:00:00.000Z',
      checkInDateLocalized: '2026-11-20', checkOutDateLocalized: '2026-11-22',
      guest: { fullName: 'Daniel Muster' }, guestsCount: 8, source: 'airbnb2', createdAt: '2026-11-17T08:13:10.000Z',
      // #1242: money wie GET /reservations/{id} am 19.11.2026 — nur die Netto-Position (AF, CHANNEL)
      money: {
        currency: 'EUR', fareAccommodation: 3118.05, fareAccommodationAdjusted: 3118.05, subTotalPrice: 3118.05,
        hostPayout: 3118.05, fareCleaning: 0, totalTaxes: 0, hostServiceFee: 0,
      },
    };

    beforeEach(() => {
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
          id INTEGER PRIMARY KEY AUTOINCREMENT, inquiry_id TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL,
          status TEXT NOT NULL, check_in TEXT NOT NULL, check_out TEXT NOT NULL, guest_name TEXT,
          guests_count INTEGER, source TEXT, currency TEXT, total_price REAL, host_payout REAL,
          guest_total REAL, price_basis TEXT,
          created_at_guesty TEXT, last_synced_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      setDatabase(db);
    });
    afterEach(() => { resetDatabase(); db.close(); });

    /** Echte Prefetch-Kette gegen die Test-DB; nur Thread-Lookup und Guesty-Abruf gemockt. */
    function realPrefetch(getReservation: (id: string) => Promise<any>) {
      return (threadId: string) => prefetchInquiryForThread(threadId, {
        getThread: (id) => (id === daniel.id ? daniel : null),
        hasReservation: (id) => getReservationById(id) !== null,
        hasInquiry: (id) => getInquiryById(id) !== null,
        getReservation,
        upsertInquiry: (r) => upsertGuestyInquiries([r]),
      });
    }

    /** Draft-Gen-Double: hält fest, was Entwurf, Gate und Task zu diesem Zeitpunkt sehen. */
    function captureDrafts() {
      const seen: { period: ReturnType<typeof resolveBookingPeriod>; summary: ReturnType<typeof resolveThreadBookingSummary>; context: string | null; title: string }[] = [];
      const generateDrafts = vi.fn(async () => {
        const period = resolveBookingPeriod(daniel);
        seen.push({
          period,
          summary: resolveThreadBookingSummary(daniel),
          context: buildBookingContext(daniel),
          title: buildBookingTaskTitle({ guestName: daniel.guest_name, property: fh, periodLabel: period.periodLabel, guestsCount: period.guestsCount }),
        });
      });
      return { seen, generateDrafts };
    }

    it('Thread ohne inquiries-Zeile → genau ein getReservation, danach Zeitraum, Personen und Preis für Entwurf, Thread-Kopf und Task-Titel', async () => {
      const getReservation = vi.fn().mockResolvedValue(guestyReservation);
      const { seen, generateDrafts } = captureDrafts();
      const d = deps({ prefetchInquiry: realPrefetch(getReservation), generateDrafts });

      await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);

      expect(getReservation).toHaveBeenCalledTimes(1);
      expect(getReservation).toHaveBeenCalledWith(RES_ID);
      expect(seen).toHaveLength(1);
      expect(seen[0].period).toEqual({ periodLabel: '20.11.2026–22.11.2026', guestsCount: 8 });
      expect(seen[0].summary).toMatchObject({
        kind: 'inquiry', checkIn: '2026-11-20', checkOut: '2026-11-22', nights: 2, guestsCount: 8,
        totalPrice: 3118.05, hostPayout: 3118.05, currency: 'EUR',
        // #1242: Thread-Kopf zeigt denselben berechneten Gastbetrag wie der Kontext
        guestPrice: { kind: 'estimated', inclTax: 3948.3, exclTax: 3690, currency: 'EUR', channel: 'Airbnb' },
      });
      expect(seen[0].context).toContain('Zeitraum 20.11.2026–22.11.2026');
      expect(seen[0].context).toContain('8 Personen');
      // #1242: Gastbetrag laut Airbnb (berechnet, mit Steuer), nie die Auszahlung 3.118,05
      expect(seen[0].context).toContain('Gesamtpreis für den Gast laut Airbnb ca. 3.948,30 EUR inkl. Steuern');
      expect(seen[0].context).toContain('ohne Steuern ca. 3.690,00 EUR');
      expect(seen[0].context).not.toContain('3.118,05');
      expect(seen[0].title).toBe('Airbnb-Anfrage Daniel: FH 20.11.2026–22.11.2026, 8 P.');
    });

    it('inquiries-Zeile existiert schon → kein Abruf', async () => {
      upsertGuestyInquiries([guestyReservation]);
      const getReservation = vi.fn().mockResolvedValue(guestyReservation);
      const { seen, generateDrafts } = captureDrafts();
      await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, deps({ prefetchInquiry: realPrefetch(getReservation), generateDrafts }));
      expect(getReservation).not.toHaveBeenCalled();
      expect(seen[0].period.guestsCount).toBe(8);
    });

    it('reservations-Zeile existiert → kein Abruf', async () => {
      db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in_localized, check_out_localized, nights_count, status, guests_count) VALUES (?,?,?,?,?,?,?)`)
        .run(RES_ID, 'G2', '2026-11-20', '2026-11-22', 2, 'confirmed', 8);
      const getReservation = vi.fn().mockResolvedValue(guestyReservation);
      await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, deps({ prefetchInquiry: realPrefetch(getReservation) }));
      expect(getReservation).not.toHaveBeenCalled();
    });

    it('Abruf wirft → Entwurf (samt Gate/Task) läuft trotzdem, nur ohne Daten', async () => {
      const getReservation = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'));
      const { seen, generateDrafts } = captureDrafts();
      await expect(handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, deps({ prefetchInquiry: realPrefetch(getReservation), generateDrafts }))).resolves.toBeUndefined();
      expect(getReservation).toHaveBeenCalledTimes(1);
      expect(generateDrafts).toHaveBeenCalledTimes(1);
      expect(seen[0].period).toEqual({ periodLabel: null, guestsCount: null });
      expect(seen[0].title).toBe('Airbnb-Anfrage Daniel: FH');
      expect(messageSyncLock.holder).toBeNull();
    });

    it('fremde prefetch-Dep wirft → Entwurf läuft trotzdem', async () => {
      const d = deps({ prefetchInquiry: vi.fn().mockRejectedValue(new Error('boom')) });
      await expect(handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d)).resolves.toBeUndefined();
      expect(d.generateDrafts).toHaveBeenCalledWith(props[1], ['guesty:c1']);
    });
  });
});
