// #1243: Gegenangebot-Notiz für Thread-Kopf und Buchungsanfrage-Task (booking-context gemockt).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageThread, Message } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';
import type { ThreadBookingSummary } from './booking-context.js';

const summaryMock = vi.fn<(t: MessageThread) => ThreadBookingSummary | null>();
vi.mock('./booking-context.js', () => ({ resolveThreadBookingSummary: (t: MessageThread) => summaryMock(t) }));

const { resolveCounterOfferNote } = await import('./counter-offer-context.js');

const thread = { id: 't1' } as MessageThread;
const farmhouse = { slug: 'farmhouse', airbnbDiscount: { shortNoticeDays: 7, weekend: true } } as PropertyConfig;
const msg = (id: string, direction: Message['direction'], body: string) => ({ id, direction, body, sent_at: `2026-11-17T10:0${id}:00Z` }) as Message;

const daniel = (over: Partial<ThreadBookingSummary> = {}): ThreadBookingSummary => ({
  kind: 'inquiry', status: 'inquiry', checkIn: '2026-11-20', checkOut: '2026-11-22', nights: 2, guestsCount: 8,
  adults: null, children: null, hostPayout: 3118.05, totalPrice: 3118.05, currency: 'EUR', platform: 'airbnb2',
  guestPrice: { kind: 'estimated', inclTax: 3948.3, exclTax: 3690, currency: 'EUR', channel: 'Airbnb' },
  requestedAt: '2026-11-17T10:00:00.000Z', ...over,
});

beforeEach(() => { summaryMock.mockReset().mockReturnValue(daniel()); });

describe('resolveCounterOfferNote', () => {
  const messages = [msg('1', 'inbound', 'Wir könnten 2.600 Euro anbieten')];

  it('Fall Daniel: Notiz mit Abstand und erfüllter Bedingung', () => {
    const n = resolveCounterOfferNote(thread, messages, farmhouse)!;
    expect(n.replace(/ /g, ' ')).toBe(
      'Betrag in der Gastnachricht 2.600 € (mögliches Gegenangebot): 1.348,30 € bzw. 34,1 % unter dem Gastpreis ca. 3.948,30 € inkl. Steuern · Nachlass-Bedingung laut Objektregel: erfüllt (Wochenende, Anfrage 3 Tage vor Anreise)',
    );
    expect(n).not.toMatch(/3\.118|Auszahlung|15,5/);
  });
  it('ohne Objektregel entfällt der Bedingungsteil; property null ok', () => {
    expect(resolveCounterOfferNote(thread, messages, null)).not.toContain('Nachlass-Bedingung');
  });
  it('actual → ohne „ca.“', () => {
    summaryMock.mockReturnValue(daniel({ guestPrice: { kind: 'actual', total: 3948.3, currency: 'EUR', channel: 'Airbnb' } }));
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).not.toContain('ca.');
  });
  it('null bei Reservierung, accommodation, fehlendem Gastpreis oder fehlender Zusammenfassung', () => {
    summaryMock.mockReturnValue(daniel({ kind: 'reservation' }));
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).toBeNull();
    summaryMock.mockReturnValue(daniel({ guestPrice: { kind: 'accommodation', amount: 3000, currency: 'EUR', channel: 'Airbnb' } }));
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).toBeNull();
    summaryMock.mockReturnValue(daniel({ guestPrice: null }));
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).toBeNull();
    summaryMock.mockReturnValue(null);
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).toBeNull();
  });
  it('nimmt die neueste Gastnachricht mit Betrag; Host-Nachrichten zählen nicht', () => {
    const ms = [msg('1', 'inbound', 'Wir bieten 3.000 €'), msg('2', 'outbound', 'Wie wäre 3.500 €?'), msg('3', 'inbound', 'Dann 2.600 €'), msg('4', 'inbound', 'Danke!')];
    expect(resolveCounterOfferNote(thread, ms, farmhouse)).toContain('2.600 €');
  });
  // Prüfer-Befund 4 und 5
  it('Nebenbeträge in der Gastnachricht („Kostet der Hund 30 € extra?“, „Endreinigung 390 € ist ok“) → keine Notiz', () => {
    expect(resolveCounterOfferNote(thread, [msg('1', 'inbound', 'Kostet der Hund 30 € extra?')], farmhouse)).toBeNull();
    expect(resolveCounterOfferNote(thread, [msg('1', 'inbound', 'Die Endreinigung 390 € ist ok.')], farmhouse)).toBeNull();
  });
  it('Nicht-Airbnb-Anfrage: Abstand ja, aber keine Bedingungszeile', () => {
    summaryMock.mockReturnValue(daniel({ platform: 'homeaway', guestPrice: { kind: 'actual', total: 3948.3, currency: 'EUR', channel: 'Plattform' } }));
    const n = resolveCounterOfferNote(thread, messages, farmhouse)!;
    expect(n).toContain('34,1 %');
    expect(n).not.toContain('Nachlass-Bedingung');
  });
  it('onlyLatestGuestMessage: nur die letzte inbound-Nachricht', () => {
    const ms = [msg('1', 'inbound', 'Dann 2.600 €'), msg('2', 'inbound', 'Danke!')];
    expect(resolveCounterOfferNote(thread, ms, farmhouse, { onlyLatestGuestMessage: true })).toBeNull();
    expect(resolveCounterOfferNote(thread, ms, farmhouse)).not.toBeNull();
  });
  it('Angebot ≥ Gastpreis oder kein Betrag → null', () => {
    expect(resolveCounterOfferNote(thread, [msg('1', 'inbound', 'Wir zahlen 5.000 €')], farmhouse)).toBeNull();
    expect(resolveCounterOfferNote(thread, [msg('1', 'inbound', 'Hallo!')], farmhouse)).toBeNull();
  });
  it('wirft nie', () => {
    summaryMock.mockImplementation(() => { throw new Error('db weg'); });
    expect(resolveCounterOfferNote(thread, messages, farmhouse)).toBeNull();
  });
});
