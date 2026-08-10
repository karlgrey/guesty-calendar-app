import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { buildBookingContext } from './booking-context.js';
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
