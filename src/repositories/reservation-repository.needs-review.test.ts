import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getRecentCheckoutIdsNeedingReview } from './reservation-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT, listing_id TEXT,
      check_in TEXT, check_out TEXT, status TEXT, source TEXT
    );
    CREATE TABLE review_drafts (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL
    );
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function ins(reservation_id: string, checkOutExpr: string, status = 'confirmed', listingId = 'L1', source = 'airbnb2') {
  db.prepare(`INSERT INTO reservations (reservation_id,listing_id,check_in,check_out,status,source)
    VALUES (?, ?, date('now', '-20 day'), date('now', ?), ?, ?)`).run(reservation_id, listingId, checkOutExpr, status, source);
}

describe('getRecentCheckoutIdsNeedingReview', () => {
  it('returns confirmed/reserved checkouts within the lookback window that have no review draft yet', () => {
    ins('recent', '-2 day');           // checked out 2 days ago -> included
    ins('today', '+0 day');            // checks out today -> included (already past/at checkout)
    ins('future', '+2 day');           // not checked out yet -> excluded
    ins('too-old', '-20 day');         // outside the -13 day lookback -> excluded
    ins('already-drafted', '-1 day');  // has a review_drafts row -> excluded
    db.prepare(`INSERT INTO review_drafts (id, reservation_id) VALUES ('rd1', 'already-drafted')`).run();

    const ids = getRecentCheckoutIdsNeedingReview('L1', '-13 days', 10);
    expect(ids.sort()).toEqual(['recent', 'today'].sort());
  });

  it('only includes Airbnb-sourced reservations (#377 bug: manual/direct bookings got review drafts)', () => {
    ins('is-airbnb2', '-1 day', 'confirmed', 'L1', 'airbnb2');   // Guesty Airbnb channel -> included
    ins('is-hostex-airbnb', '-1 day', 'confirmed', 'L1', 'airbnb'); // Hostex channel_type -> included
    ins('is-manual', '-1 day', 'confirmed', 'L1', 'manual');     // direct booking (the S. Fischer Verlag bug case) -> excluded
    ins('is-booking-com', '-1 day', 'confirmed', 'L1', 'Booking.com'); // -> excluded
    ins('is-landfolk', '-1 day', 'confirmed', 'L1', 'Landfolk'); // -> excluded
    ins('is-vrbo', '-1 day', 'confirmed', 'L1', 'vrboLite');     // -> excluded
    ins('is-null-source', '-1 day', 'confirmed', 'L1', null as unknown as string); // unset -> excluded conservatively

    const ids = getRecentCheckoutIdsNeedingReview('L1', '-13 days', 10);
    expect(ids.sort()).toEqual(['is-airbnb2', 'is-hostex-airbnb'].sort());
  });

  it('excludes non-active statuses (canceled/declined/expired)', () => {
    ins('cancelled', '-1 day', 'canceled');
    ins('declined', '-1 day', 'declined');
    ins('confirmed-one', '-1 day', 'confirmed');
    const ids = getRecentCheckoutIdsNeedingReview('L1', '-13 days', 10);
    expect(ids).toEqual(['confirmed-one']);
  });

  it('filters by listing_id', () => {
    ins('a', '-1 day', 'confirmed', 'L1');
    ins('b', '-1 day', 'confirmed', 'L2');
    expect(getRecentCheckoutIdsNeedingReview('L1', '-13 days', 10)).toEqual(['a']);
    expect(getRecentCheckoutIdsNeedingReview('L2', '-13 days', 10)).toEqual(['b']);
  });

  it('respects the limit', () => {
    ins('a', '-1 day'); ins('b', '-2 day');
    expect(getRecentCheckoutIdsNeedingReview('L1', '-13 days', 1).length).toBe(1);
  });

  it('returns [] when nothing matches', () => {
    expect(getRecentCheckoutIdsNeedingReview('none', '-13 days', 10)).toEqual([]);
  });
});
