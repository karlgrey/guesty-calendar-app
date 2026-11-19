// #1099 Vertragstests: anonymisierte echte Guesty-Antworten (Live-Probe 19.11.2026, eine
// Direktbuchung Farmhouse, eine Airbnb-Buchung U19). „Vorher" = Legacy `GET /reservations/{id}`,
// „nachher" = v3-Einzelabruf + /payments + guests-crud durch den Adapter.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  adaptV3Reservation,
  adaptV3SearchResult,
  wallClockToUtcIso,
  wallClockHhmm,
  nightsBetweenLocalDates,
  toLegacyGuest,
} from './guesty-v3-adapter.js';
import { toReservationView } from './reservation-update-service.js';
import { extractPricingFromReservation, buildDocumentDataFromReservation } from './document-service.js';
import { mapGuestyInquiryRow } from '../jobs/sync-inquiries.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/guesty-v3');
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

const TZ = () => 'Europe/Berlin';
const CASES = ['manual', 'airbnb'] as const;

function fixtures(kind: (typeof CASES)[number]) {
  const legacy = load(`legacy-get-${kind}.json`);
  const v3 = load(`v3-by-ids-${kind}.json`)[0];
  const payments = load(`payments-${kind}.json`);
  const guest = load(`guests-crud-${kind}.json`);
  const search = load(`v3-search-${kind}.json`).results[0];
  const adapted = adaptV3Reservation(v3, { payments, guest, timezoneFor: TZ });
  return { legacy, v3, payments, guest, search, adapted };
}

// Lokales Listing wie in der listings-Tabelle (Fallbacks in extractPricingFromReservation)
const LISTING = { guests_included: 5, extra_person_fee: 100, currency: 'EUR' };

describe('Hilfsfunktionen', () => {
  it('Wanduhr → UTC mit Sommer- und Winterzeit', () => {
    expect(wallClockToUtcIso('2027-06-26T08:00:00.000Z', 'Europe/Berlin')).toBe('2027-06-26T06:00:00.000Z');
    expect(wallClockToUtcIso('2026-11-25T15:00:00.000Z', 'Europe/Berlin')).toBe('2026-11-25T14:00:00.000Z');
  });
  it('ohne Zeitzone kein Raten: Wert bleibt', () => {
    expect(wallClockToUtcIso('2026-11-25T15:00:00.000Z', null)).toBe('2026-11-25T15:00:00.000Z');
    expect(wallClockToUtcIso(undefined, 'Europe/Berlin')).toBeUndefined();
  });
  it('HH:MM aus eta/etd und Nächte aus lokalen Daten', () => {
    expect(wallClockHhmm('2026-11-26T12:00:00.000Z')).toBe('12:00');
    expect(wallClockHhmm(undefined)).toBeUndefined();
    expect(nightsBetweenLocalDates('2027-03-27', '2027-03-29')).toBe(2); // über Zeitumstellung
    expect(nightsBetweenLocalDates(undefined, '2027-03-29')).toBeUndefined();
  });
  it('toLegacyGuest nimmt erste Mail/Telefonnummer aus den Arrays', () => {
    expect(toLegacyGuest({ _id: 'g1', fullName: 'A B', emails: ['', 'a@example.com'], phones: ['49'] }))
      .toEqual({ _id: 'g1', fullName: 'A B', email: 'a@example.com', phone: '49' });
    expect(toLegacyGuest(null)).toBeUndefined();
  });
});

describe.each(CASES)('Einzelabruf v3 ↔ Legacy (%s)', (kind) => {
  it('Kernfelder wie Legacy', () => {
    const { legacy, adapted } = fixtures(kind);
    const keys = [
      '_id', 'listingId', 'status', 'checkIn', 'checkOut', 'checkInDateLocalized', 'checkOutDateLocalized',
      'nightsCount', 'guestsCount', 'numberOfGuests', 'plannedArrival', 'plannedDeparture', 'guestId',
      'source', 'confirmationCode', 'createdAt', 'confirmedAt',
    ];
    for (const k of keys) expect([k, adapted[k]]).toEqual([k, legacy[k]]);
    // Legacy null, v3 fehlt: für alle Aufrufer gleichwertig (?? / ||)
    expect(adapted.reservedAt ?? null).toEqual(legacy.reservedAt ?? null);
    expect(adapted.guest).toMatchObject({
      _id: legacy.guest._id, firstName: legacy.guest.firstName, lastName: legacy.guest.lastName, fullName: legacy.guest.fullName,
    });
  });

  it('money wertgleich inkl. Zahlungsfeldern aus /payments', () => {
    const { legacy, adapted } = fixtures(kind);
    const skip = new Set(['settingsSnapshot', 'payments', 'updatedAt']);
    for (const k of Object.keys(legacy.money)) {
      if (skip.has(k)) continue;
      expect([k, adapted.money[k]]).toEqual([k, legacy.money[k]]);
    }
    for (const k of ['guestsIncludedInRegularFee', 'extraPersonFee', 'taxes']) {
      expect([k, adapted.money.settingsSnapshot[k]]).toEqual([k, legacy.money.settingsSnapshot[k]]);
    }
    expect(adapted.money.payments).toHaveLength(legacy.money.payments.length);
  });

  it('AK3: Agent-API-Sicht (toReservationView) identisch', () => {
    const { legacy, adapted } = fixtures(kind);
    expect(toReservationView(adapted, 'x')).toEqual(toReservationView(legacy, 'x'));
  });

  it('AK4: Belegbeträge Angebot/Rechnung auf den Cent gleich', () => {
    const { legacy, adapted, guest } = fixtures(kind);
    expect(extractPricingFromReservation(adapted, LISTING)).toEqual(extractPricingFromReservation(legacy, LISTING));
    const today = new Date('2026-11-19T12:00:00Z');
    for (const type of ['quote', 'invoice'] as const) {
      expect(buildDocumentDataFromReservation('x', type, adapted, guest, LISTING, today))
        .toEqual(buildDocumentDataFromReservation('x', type, legacy, guest, LISTING, today));
    }
  });

  it('AK5 (Einzelabruf/Prefetch): inquiries-Zeile identisch', () => {
    const { legacy, adapted } = fixtures(kind);
    const now = '2026-11-19T12:00:00.000Z';
    expect(mapGuestyInquiryRow(adapted, now)).toEqual(mapGuestyInquiryRow(legacy, now));
  });

  it('ohne payments/guest: Kernsicht unverändert, Zahlungsfelder fehlen', () => {
    const { legacy, v3 } = fixtures(kind);
    const bare = adaptV3Reservation(v3, { timezoneFor: TZ });
    expect(toReservationView(bare, 'x')).toEqual(toReservationView(legacy, 'x'));
    expect(bare.money.balanceDue).toBeUndefined();
    expect(bare.guest).toBeUndefined();
  });
});

describe.each(CASES)('search v3 ↔ Legacy-Liste (%s)', (kind) => {
  it('Listenfelder wie Legacy', () => {
    const { legacy, search } = fixtures(kind);
    const item = adaptV3SearchResult(search, { timezoneFor: TZ });
    for (const k of ['_id', 'listingId', 'status', 'checkIn', 'checkOut', 'checkInDateLocalized', 'checkOutDateLocalized',
      'guestsCount', 'guestId', 'source', 'createdAt', 'confirmationCode']) {
      expect([k, item[k]]).toEqual([k, legacy[k]]);
    }
    expect(item.money).toBeUndefined();
    expect(item.guest).toBeUndefined();
  });

  it('AK5: search + money (v3-Einzelabruf) + Gastname ergibt dieselbe inquiries-Zeile', () => {
    const { legacy, search, v3, guest } = fixtures(kind);
    const item = { ...adaptV3SearchResult(search, { timezoneFor: TZ }), money: v3.money, guest: { fullName: guest.fullName } };
    const now = '2026-11-19T12:00:00.000Z';
    expect(mapGuestyInquiryRow(item, now)).toEqual(mapGuestyInquiryRow(legacy, now));
  });
});

describe('Folio-Overview (Probe, nicht verwendet): Beleg für die Entscheidung', () => {
  it('Folio benennt Felder anders als money; der Adapter liest money aus dem v3-Einzelabruf', () => {
    const folio = load('folio-overview-airbnb.json').results[0];
    const legacy = load('legacy-get-airbnb.json');
    expect(folio.hostPayout).toBe(legacy.money.hostPayout);
    expect(folio.channelCommission).toBe(legacy.money.hostServiceFee);
    // fareAccommodationAdjusted (inquiries.total_price, #1242) hat im Folio kein eindeutiges
    // Gegenstück (rawAccommodationFare/accommodationFareNet), deshalb money aus v3-by-ids.
    expect(folio.fareAccommodationAdjusted).toBeUndefined();
  });
});
