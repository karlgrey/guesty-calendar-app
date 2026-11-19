import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { buildBookingContext, resolveBookingPeriod } from './booking-context.js';
import { parseBookingPeriod } from './auto-send/today-facts.js';
import type { MessageThread } from '../types/messages.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, guests_count INTEGER, confirmation_code TEXT
    );
    CREATE TABLE inquiries (
      id INTEGER PRIMARY KEY, inquiry_id TEXT UNIQUE, status TEXT,
      check_in TEXT, check_out TEXT, guest_name TEXT, guests_count INTEGER
    );
  `);
  setDatabase(db);
});

afterEach(() => { resetDatabase(); db.close(); });

function thread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 't1', listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'Guest',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1,
    reservation_id: null, inquiry_id: null, reservation_status: null, conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null,
    ai_no_reply_at: null, last_synced_at: '',
    ...over,
  };
}

describe('buildBookingContext', () => {
  it('returns booking context for a confirmed reservation', () => {
    db.prepare(`
      INSERT INTO reservations
        (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, guests_count, confirmation_code)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run('HME9WZFQTY', 'L1', '2026-08-02T15:00:00.000Z', '2026-08-07T12:00:00.000Z', '2026-08-02', '2026-08-07', 5, 'confirmed', 2, 'HME9WZFQTY');

    const t = thread({ reservation_id: 'HME9WZFQTY', reservation_status: 'confirmed' });
    const ctx = buildBookingContext(t);

    expect(ctx).not.toBeNull();
    expect(ctx).toContain('02.08.2026');
    expect(ctx).toContain('07.08.2026');
    expect(ctx).toContain('5 Nächte');
    expect(ctx).toContain('2 Personen');
    expect(ctx).toContain('HME9WZFQTY');
    expect(ctx).toContain('confirmed');
  });

  it('returns booking context for an unconfirmed inquiry', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ1', 'inquiry', '2026-09-10', '2026-09-15', 'Max Mustermann', 3);

    const t = thread({ inquiry_id: 'INQ1' });
    const ctx = buildBookingContext(t);

    expect(ctx).not.toBeNull();
    expect(ctx).toContain('Buchungsanfrage');
    expect(ctx).toContain('noch nicht bestätigt');
    expect(ctx).toContain('10.09.2026');
    expect(ctx).toContain('15.09.2026');
    expect(ctx).toContain('5 Nächte');
    expect(ctx).toContain('3 Personen');
    expect(ctx).toContain('Daten stammen aus der Anfrage selbst');
  });

  describe('#1244: bestätigte/reservierte Einzelabruf-Zeile ist eine Buchung', () => {
    function insertStatus(id: string, status: string) {
      db.prepare(`
        INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
        VALUES (?,?,?,?,?,?)
      `).run(id, status, '2026-12-15', '2026-12-17', 'Gast', 8);
    }

    it('confirmed: "Buchung (bestätigt)" ohne Anfrage-Zusatz, Rabatt und Gegenangebot-Kontext', () => {
      insertStatus('INQ-C', 'confirmed');
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-C' }), { discountRule: { shortNoticeDays: 7, weekend: true } })!;
      expect(ctx).toContain('Buchung (bestätigt): Zeitraum 15.12.2026–17.12.2026, 2 Nächte, 8 Personen');
      expect(ctx).not.toContain('Buchungsanfrage');
      expect(ctx).not.toContain('noch nicht bestätigt');
      expect(ctx).not.toContain('Nachlass-Bedingung');
      expect(ctx).not.toContain('Übernachtungen in den Nächten');
      expect(ctx).not.toContain('Gesamtpreis');
    });

    it('reserved: "Buchung (reserviert)"', () => {
      insertStatus('INQ-R', 'reserved');
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-R' }))!;
      expect(ctx).toContain('Buchung (reserviert): Zeitraum 15.12.2026–17.12.2026, 2 Nächte, 8 Personen');
      expect(ctx).not.toContain('noch nicht bestätigt');
    });

    it('canceled bleibt wie bisher Buchungsanfrage', () => {
      insertStatus('INQ-X', 'canceled');
      expect(buildBookingContext(thread({ inquiry_id: 'INQ-X' }))).toContain('Buchungsanfrage (noch nicht bestätigt)');
    });
  });

  describe('#1242: Gastbetrag laut Airbnb im Anfrage-Kontext', () => {
    const RATES = { hostServiceFeeRate: 0.155, taxRate: 0.07 };
    const PREFIX = 'Buchungsanfrage (noch nicht bestätigt): Zeitraum 20.11.2026–22.11.2026, 2 Nächte, 8 Personen';
    // #1243: ohne created_at_guesty nur der Nächte-Satz (Fr/Sa-Nacht), kein „Anfrage gestellt“
    const SUFFIX = ' — Daten stammen aus der Anfrage selbst. Übernachtungen in den Nächten ab Freitag, Samstag (Wochenendnacht Fr/Sa dabei: ja).';

    beforeEach(() => {
      db.exec(`ALTER TABLE inquiries ADD COLUMN source TEXT; ALTER TABLE inquiries ADD COLUMN currency TEXT;
        ALTER TABLE inquiries ADD COLUMN total_price REAL; ALTER TABLE inquiries ADD COLUMN host_payout REAL;
        ALTER TABLE inquiries ADD COLUMN guest_total REAL; ALTER TABLE inquiries ADD COLUMN price_basis TEXT;`);
    });

    function insert(over: Record<string, unknown>) {
      const row = {
        inquiry_id: 'INQ-D', status: 'inquiry', check_in: '2026-11-20', check_out: '2026-11-22', guest_name: 'Daniel',
        guests_count: 8, source: 'airbnb2', currency: 'EUR', total_price: null, host_payout: null, guest_total: null,
        price_basis: null, ...over,
      };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO inquiries (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
    }

    it('Fall Daniel (nur Netto-Auszahlung 3.118,05): berechneter Gastbetrag mit Steuer als Hauptwert, ohne Steuer daneben', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES });
      expect(ctx).toBe(
        `${PREFIX}, Gesamtpreis für den Gast laut Airbnb ca. 3.948,30 EUR inkl. Steuern ` +
        `(berechnet, ungefähr; ohne Steuern ca. 3.690,00 EUR)${SUFFIX}`,
      );
    });

    it('die Auszahlung erscheint nie im Kontext, auch nicht Gebührensatz oder Rechenweg', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })!;
      expect(ctx).not.toContain('3.118,05');
      expect(ctx).not.toContain('3118');
      expect(ctx).not.toMatch(/Auszahlung|Gebühr|15,5|0,845|Payout/i);
    });

    it('echter Gastbetrag (Anfrage inzwischen mit voller Aufstellung) → ohne „ca." und „berechnet"', () => {
      insert({ total_price: 139, host_payout: 163.78, guest_total: 191.53, price_basis: 'guest_total' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })!;
      expect(ctx).toBe(`${PREFIX}, Gesamtpreis für den Gast laut Airbnb 191,53 EUR inkl. Steuern${SUFFIX}`);
      expect(ctx).not.toContain('163,78');
    });

    it('ohne Gastbetrag, aber echter Übernachtungspreis → Rückfall mit ehrlicher Bezeichnung', () => {
      insert({ total_price: 4400, host_payout: 4750, price_basis: 'accommodation' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })!;
      expect(ctx).toBe(`${PREFIX}, Übernachtungspreis laut Airbnb 4.400,00 EUR (ohne Reinigung, Steuern und Gebühren)${SUFFIX}`);
      expect(ctx).not.toContain('4.750');
    });

    it('Netto-Auszahlung ohne konfigurierte Sätze → gar kein Preis (die Auszahlung ist kein Gastpreis)', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: null })!;
      expect(ctx).toBe(`${PREFIX}${SUFFIX}`);
    });

    it('Altbestand ohne price_basis (vor dem ersten Sync nach Migration 043) → kein Preis', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05 });
      expect(buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })).toBe(`${PREFIX}${SUFFIX}`);
    });

    it('#1243: Anfrage-Zeitpunkt und Wochentage der Nächte hinter dem Zeitraum-Satz (Fall Daniel)', () => {
      db.exec('ALTER TABLE inquiries ADD COLUMN created_at_guesty TEXT;');
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout', created_at_guesty: '2026-11-17T10:00:00.000Z' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })!;
      expect(ctx).toContain('Zeitraum 20.11.2026–22.11.2026');
      expect(ctx).toMatch(/Daten stammen aus der Anfrage selbst\. Anfrage gestellt am 17\.11\.2026, 3 Tage vor Anreise\. Übernachtungen in den Nächten ab Freitag, Samstag \(Wochenendnacht Fr\/Sa dabei: ja\)\.$/);
    });

    // #1243: Bedingung der Objekt-Rabattlinie als Fakt (nur Objekte mit airbnbDiscount).
    it('#1243: mit Objekt-Rabattlinie steht die ausgewertete Nachlass-Bedingung am Ende (Fall Daniel: erfüllt)', () => {
      db.exec('ALTER TABLE inquiries ADD COLUMN created_at_guesty TEXT;');
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout', created_at_guesty: '2026-11-17T10:00:00.000Z' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES, discountRule: { shortNoticeDays: 7, weekend: true } })!;
      expect(ctx).toMatch(/\(Wochenendnacht Fr\/Sa dabei: ja\)\. Nachlass-Bedingung laut Objektregel: erfüllt \(Wochenende, Anfrage 3 Tage vor Anreise\)\.$/);
    });

    it('#1243: Bedingung nicht erfüllt (Wochentage, Anfrage weit vorher)', () => {
      db.exec('ALTER TABLE inquiries ADD COLUMN created_at_guesty TEXT;');
      insert({ check_in: '2026-12-15', check_out: '2026-12-17', total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout', created_at_guesty: '2026-11-19T10:00:00.000Z' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES, discountRule: { shortNoticeDays: 7, weekend: true } })!;
      expect(ctx).toContain('Nachlass-Bedingung laut Objektregel: nicht erfüllt (kein Wochenende, Anfrage 26 Tage vor Anreise).');
    });

    it('#1243 (Prüfer-Befund 5): Nicht-Airbnb-Anfrage am Objekt mit Rabattlinie → keine Bedingungszeile', () => {
      insert({ source: 'website', total_price: 3000, price_basis: 'accommodation' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES, discountRule: { shortNoticeDays: 7, weekend: true } })!;
      expect(ctx).not.toContain('Nachlass-Bedingung');
    });

    // #1244 (Prüfer): Kernfall mit vollständigen Geld- und Rabattdaten. Dieselbe Zeile ergäbe als offene
    // Anfrage Gesamtpreis, Anfrage-Zeitpunkt und „Nachlass-Bedingung … erfüllt" (Test weiter oben) — die
    // Tests im #1244-Block laufen ohne Geld-/Kanal-Spalten und belegen das Weglassen deshalb nicht.
    it('#1244: bestätigte Zeile mit Preis- und Rabattdaten → nur Buchungszeile; Zeitraum für today-facts lesbar', () => {
      db.exec('ALTER TABLE inquiries ADD COLUMN created_at_guesty TEXT;');
      insert({ status: 'confirmed', total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout', created_at_guesty: '2026-11-17T10:00:00.000Z' });
      const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES, discountRule: { shortNoticeDays: 7, weekend: true } })!;
      expect(ctx).toMatch(/^Buchung \(bestätigt\): Zeitraum 20\.11\.2026–22\.11\.2026, 2 Nächte, 8 Personen — /);
      expect(ctx).not.toMatch(/Gesamtpreis|Übernachtungspreis|3\.948|3\.690|3\.118|Nachlass-Bedingung|Anfrage gestellt|Übernachtungen in den Nächten|noch nicht bestätigt/);
      expect(parseBookingPeriod(ctx)).toEqual({ checkIn: '2026-11-20', checkOut: '2026-11-22' });
    });

    it('#1243: ohne Objekt-Rabattlinie keine Bedingungszeile', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
      expect(buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES, discountRule: null })).not.toContain('Nachlass-Bedingung');
      expect(buildBookingContext(thread({ inquiry_id: 'INQ-D' }), { rates: RATES })).not.toContain('Nachlass-Bedingung');
    });

    it('ohne Optionen gelten die Sätze aus data/properties.json (15,5 % / 7 %)', () => {
      insert({ total_price: 3118.05, host_payout: 3118.05, price_basis: 'net_payout' });
      expect(buildBookingContext(thread({ inquiry_id: 'INQ-D' }))).toContain('ca. 3.948,30 EUR inkl. Steuern');
    });
  });

  it('#1234: Anfrage ohne Preis → kein Preis-Teil; 0 Personen (Guesty-Sync "unbekannt") → Personenzahl unbekannt', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-0', 'inquiry', '2026-11-20', '2026-11-22', 'X', 0);

    const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-0' }));
    expect(ctx).toContain('Personenzahl unbekannt');
    expect(ctx).not.toContain('Preis');
  });

  it('nightsBetween: zählt korrekt über den Frühjahrs-DST-Übergang Europe/Berlin (29.03.2026)', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-DST-SPRING', 'inquiry', '2026-03-27', '2026-03-31', 'DST-Test', 2);

    const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-DST-SPRING' }));
    expect(ctx).toContain('4 Nächte');
  });

  it('nightsBetween: zählt korrekt über den Herbst-DST-Übergang Europe/Berlin (25.10.2026)', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-DST-AUTUMN', 'inquiry', '2026-10-23', '2026-10-27', 'DST-Test', 2);

    const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-DST-AUTUMN' }));
    expect(ctx).toContain('4 Nächte');
  });

  it('nightsBetween: zählt korrekt über einen Jahreswechsel', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-NYE', 'inquiry', '2026-12-29', '2027-01-03', 'NYE-Test', 2);

    const ctx = buildBookingContext(thread({ inquiry_id: 'INQ-NYE' }));
    expect(ctx).toContain('5 Nächte');
  });

  it('returns null when the thread has neither reservation_id nor inquiry_id', () => {
    expect(buildBookingContext(thread())).toBeNull();
  });

  it('returns null when reservation_id is set but no matching row exists (e.g. cancelled/deleted)', () => {
    const t = thread({ reservation_id: 'HMGONE00001' });
    expect(buildBookingContext(t)).toBeNull();
  });

  it('returns null when inquiry_id is set but no matching row exists', () => {
    const t = thread({ inquiry_id: 'INQ-GONE' });
    expect(buildBookingContext(t)).toBeNull();
  });

  it('prefers reservation_id over inquiry_id when both are set', () => {
    db.prepare(`
      INSERT INTO reservations
        (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, guests_count, confirmation_code)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run('HMBOTH0001', 'L1', '2026-08-02T15:00:00.000Z', '2026-08-07T12:00:00.000Z', '2026-08-02', '2026-08-07', 5, 'confirmed', 2, 'HMBOTH0001');
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-BOTH', 'inquiry', '2026-09-10', '2026-09-15', 'Someone Else', 1);

    const t = thread({ reservation_id: 'HMBOTH0001', inquiry_id: 'INQ-BOTH' });
    const ctx = buildBookingContext(t);
    expect(ctx).toContain('02.08.2026');
    expect(ctx).not.toContain('Buchungsanfrage');
  });

  it('falls through to the inquiry row when reservation_id has no reservation (guesty inquiry threads carry both ids)', () => {
    // Prod case (Ezgi, 10.08.2026): guesty sync sets reservation_id AND
    // inquiry_id to the same Guesty id, but until confirmation only an
    // inquiries row exists — the context must come from there, not be null.
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('6a7989b2c42a6be54ce73e03', 'inquiry', '2027-07-02', '2027-07-03', 'Ezgi', 10);

    const t = thread({
      reservation_id: '6a7989b2c42a6be54ce73e03',
      inquiry_id: '6a7989b2c42a6be54ce73e03',
      reservation_status: 'inquiry',
    });
    const ctx = buildBookingContext(t);

    expect(ctx).not.toBeNull();
    expect(ctx).toContain('Buchungsanfrage');
    expect(ctx).toContain('02.07.2027');
    expect(ctx).toContain('03.07.2027');
    expect(ctx).toContain('10 Personen');
  });

});

// #697: strukturiertes Zeitraum/Personen-Paar für den Buchungsanfrage-Task-Titel.
describe('resolveBookingPeriod', () => {
  it('Reservierung: periodLabel + guestsCount aus check_in_localized/check_out_localized', () => {
    db.prepare(`
      INSERT INTO reservations
        (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, guests_count, confirmation_code)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run('HMANIKA001', 'L1', '2027-01-29T15:00:00.000Z', '2027-01-31T12:00:00.000Z', '2027-01-29', '2027-01-31', 2, 'reserved', 15, 'HMANIKA001');
    const r = resolveBookingPeriod(thread({ reservation_id: 'HMANIKA001' }));
    expect(r).toEqual({ periodLabel: '29.01.2027–31.01.2027', guestsCount: 15 });
  });

  it('Inquiry: periodLabel + guestsCount aus check_in/check_out', () => {
    db.prepare(`
      INSERT INTO inquiries (inquiry_id, status, check_in, check_out, guest_name, guests_count)
      VALUES (?,?,?,?,?,?)
    `).run('INQ-ANIKA', 'inquiry', '2027-01-29', '2027-01-31', 'Anika', 15);
    const r = resolveBookingPeriod(thread({ inquiry_id: 'INQ-ANIKA' }));
    expect(r).toEqual({ periodLabel: '29.01.2027–31.01.2027', guestsCount: 15 });
  });

  it('ohne Verlinkung → beide Felder null', () => {
    expect(resolveBookingPeriod(thread())).toEqual({ periodLabel: null, guestsCount: null });
  });

  it('verlinkte Reservierung/Inquiry ohne passende Zeile → beide Felder null', () => {
    expect(resolveBookingPeriod(thread({ reservation_id: 'gone' }))).toEqual({ periodLabel: null, guestsCount: null });
  });
});
