/**
 * Sync Inquiries Job
 *
 * Fetches all inquiries and reservations from Guesty API to track conversion rates
 */

import { guestyClient } from '../services/guesty-client.js';
import logger from '../utils/logger.js';
import { getDatabase } from '../db/index.js';
import { classifyGuestyGuestPrice, type PriceBasis } from '../services/guest-price.js';

export interface SyncInquiriesResult {
  success: boolean;
  inquiriesCount: number;
  confirmedCount: number;
  error?: string;
}

/**
 * #1187: Preisdaten einer Guesty-Reservierung für die inquiries-Tabelle.
 * Semantik wie reservation-mapper.ts (currency, fareAccommodationAdjusted, hostPayout),
 * aber fehlende/nicht-numerische Werte werden NULL (unbekannt), echte 0 bleibt 0.
 *
 * ACHTUNG (#1242, Live-Befund 19.11.2026): total_price ist NICHT überall der Übernachtungspreis.
 * Bei Airbnb-ANFRAGEN liefert Guesty nur eine Position (AF, Herkunft CHANNEL) — dort ist
 * fareAccommodationAdjusted = hostPayout = Netto-Auszahlung des Gastgebers (Übernachtung +
 * Reinigung − Host-Servicegebühr, ohne Steuer). Was die Zahl bedeutet, steht in price_basis
 * (classifyGuestyGuestPrice, services/guest-price.ts); den Gastbetrag nie aus total_price ablesen.
 */
export function mapGuestyInquiryMoney(r: any): {
  currency: string | null;
  total_price: number | null;
  host_payout: number | null;
} {
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
  const currency = r?.money?.currency;
  return {
    currency: typeof currency === 'string' && currency ? currency : null,
    total_price: num(r?.money?.fareAccommodationAdjusted),
    host_payout: num(r?.money?.hostPayout),
  };
}

/** Zeile der inquiries-Tabelle aus einer Guesty-Reservierung (Liste oder Einzelabruf). */
export interface GuestyInquiryRow {
  inquiry_id: string;
  listing_id: string;
  status: string;
  check_in: string;
  check_out: string;
  guest_name: string;
  guests_count: number;
  source: string | null;
  created_at_guesty: string;
  last_synced_at: string;
  currency: string | null;
  total_price: number | null;
  host_payout: number | null;
  /** #1242: Gastbetrag inkl. Steuern laut Plattform (nur bei price_basis 'guest_total') */
  guest_total: number | null;
  /** #1242: Herkunft der Preiszahlen (Migration 043) */
  price_basis: PriceBasis | null;
}

/**
 * #1234: Mapper Guesty-Reservierung → inquiries-Zeile, gemeinsam für den Stunden-Sync
 * (syncInquiries) und den Einzelabruf beim Nachrichten-Eingang (inquiry-prefetch.ts).
 * null, wenn Pflichtfelder fehlen (_id, listingId, status, checkIn, checkOut).
 */
export function mapGuestyInquiryRow(r: any, now: string): GuestyInquiryRow | null {
  if (!r?._id || !r.listingId || !r.status || !r.checkIn || !r.checkOut) return null;

  // Extract guest name from guest object
  const guestName = r.guest?.fullName || r.guest?.firstName || 'Unknown';

  // Use checkInDateLocalized if available, otherwise parse checkIn
  const checkInDate = r.checkInDateLocalized || r.checkIn?.split('T')[0] || r.checkIn;
  const checkOutDate = r.checkOutDateLocalized || r.checkOut?.split('T')[0] || r.checkOut;

  const money = mapGuestyInquiryMoney(r);
  const guestPrice = classifyGuestyGuestPrice(r);

  return {
    inquiry_id: r._id,
    listing_id: r.listingId,
    status: r.status,
    check_in: checkInDate,
    check_out: checkOutDate,
    guest_name: guestName,
    guests_count: r.guestsCount || 0,
    source: r.source || null,
    created_at_guesty: r.createdAt || now,
    last_synced_at: now,
    currency: money.currency,
    total_price: money.total_price,
    host_payout: money.host_payout,
    guest_total: guestPrice.guest_total,
    price_basis: guestPrice.price_basis,
  };
}

/**
 * #1234: Upsert von Guesty-Reservierungen in inquiries (eine Transaktion). Liefert die Anzahl
 * geschriebener Zeilen; Reservierungen ohne Pflichtfelder werden übersprungen.
 */
export function upsertGuestyInquiries(reservations: any[], now: string = new Date().toISOString()): number {
  const db = getDatabase();
  const upsertStmt = db.prepare(`
    INSERT INTO inquiries (
      inquiry_id,
      listing_id,
      status,
      check_in,
      check_out,
      guest_name,
      guests_count,
      source,
      created_at_guesty,
      last_synced_at,
      currency,
      total_price,
      host_payout,
      guest_total,
      price_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inquiry_id) DO UPDATE SET
      status = excluded.status,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      guest_name = excluded.guest_name,
      guests_count = excluded.guests_count,
      source = excluded.source,
      last_synced_at = excluded.last_synced_at,
      -- #1187: Payload ohne money darf bekannte Preisdaten nicht löschen
      currency = COALESCE(excluded.currency, inquiries.currency),
      total_price = COALESCE(excluded.total_price, inquiries.total_price),
      host_payout = COALESCE(excluded.host_payout, inquiries.host_payout),
      -- #1242: guest_total und price_basis nur gemeinsam und nur bei bekannter Herkunft
      -- überschreiben (Anfrage → Buchung wechselt net_payout → guest_total; ein Payload ohne
      -- Aufschlüsselung lässt den bekannten Stand stehen)
      guest_total = CASE WHEN excluded.price_basis IS NULL THEN inquiries.guest_total ELSE excluded.guest_total END,
      price_basis = COALESCE(excluded.price_basis, inquiries.price_basis)
  `);

  const upsertMany = db.transaction((items: any[]): number => {
    let written = 0;
    for (const r of items) {
      const row = mapGuestyInquiryRow(r, now);
      if (!row) {
        // Skip if missing required fields
        logger.debug({ reservation: r?._id }, 'Skipping reservation with missing required fields');
        continue;
      }
      upsertStmt.run(
        row.inquiry_id,
        row.listing_id,
        row.status,
        row.check_in,
        row.check_out,
        row.guest_name,
        row.guests_count,
        row.source,
        row.created_at_guesty,
        row.last_synced_at,
        row.currency,
        row.total_price,
        row.host_payout,
        row.guest_total,
        row.price_basis,
      );
      written++;
    }
    return written;
  });

  return upsertMany(reservations);
}

/**
 * Sync all inquiries and reservations from Guesty API
 *
 * Fetches ALL reservation statuses (inquiry, confirmed, reserved, canceled, declined)
 * to enable accurate conversion rate tracking
 */
export async function syncInquiries(listingId: string): Promise<SyncInquiriesResult> {
  const startTime = Date.now();

  try {
    logger.info({ listingId }, 'Starting inquiry sync from Guesty API');

    // Fetch ALL reservations from Guesty API (no status filter = all statuses).
    // Note: Using limit=100 returns more results than limit=1000 (Guesty API quirk).
    // WICHTIG (#271, Fall Kemkes): mit Paginierung — ohne sie blieben Listings
    // mit >100 historischen Reservierungen bei den ältesten 100 hängen und neue
    // Buchungen/Stornos kamen nie in der inquiries-Tabelle an (Geister-Events
    // im Google-Kalender, weil getCancelledReservationIds den Storno nie sah).
    const pageSize = 100;
    const maxPages = 50; // Sicherheitsgrenze (5.000 Reservierungen pro Listing)
    const allReservations: any[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = (await guestyClient.getReservations({
        listingId,
        limit: pageSize,
        ...(page > 0 ? { skip: page * pageSize } : {}),
      })) ?? [];
      allReservations.push(...batch);
      if (batch.length < pageSize) break;
      if (page === maxPages - 1) {
        logger.warn({ listingId, fetched: allReservations.length }, 'syncInquiries: Seiten-Sicherheitsgrenze erreicht — Liste evtl. unvollständig');
      }
    }

    logger.info(
      { count: allReservations.length, listingId },
      'Fetched reservations from Guesty API'
    );

    // Count by status
    const inquiries = allReservations.filter((r: any) => r.status === 'inquiry');
    const confirmed = allReservations.filter((r: any) =>
      r.status === 'confirmed' || r.status === 'reserved'
    );

    // Upsert to inquiries table (#1234: gemeinsamer Mapper/Upsert mit dem Einzelabruf beim Eingang)
    upsertGuestyInquiries(allReservations);

    const duration = Date.now() - startTime;

    logger.info(
      {
        listingId,
        totalCount: allReservations.length,
        inquiriesCount: inquiries.length,
        confirmedCount: confirmed.length,
        duration,
      },
      'Inquiry sync completed successfully'
    );

    return {
      success: true,
      inquiriesCount: inquiries.length,
      confirmedCount: confirmed.length,
    };
  } catch (error) {
    logger.error({ error, listingId }, 'Inquiry sync failed');
    return {
      success: false,
      inquiriesCount: 0,
      confirmedCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
