/**
 * Sync Inquiries Job
 *
 * Fetches all inquiries and reservations from Guesty API to track conversion rates
 */

import { guestyClient, diffRequestCounters } from '../services/guesty-client.js';
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

/** #1099: höchstens so viele guests-crud-Abrufe je Lauf (Rest folgt im nächsten Lauf). */
export const MAX_GUEST_FETCHES_PER_RUN = 25;
/** #1099: höchstens so viele Reservierungen je Lauf mit money nachladen (= 30 v3-Abrufe à 10). */
export const MAX_MONEY_IDS_PER_RUN = 300;
/** #1099: money auch für Aufenthalte nachladen, deren Check-out höchstens so lange zurückliegt. */
export const MONEY_REFRESH_PAST_DAYS = 7;
/** #1099: ein erfolglos nachgeladener Gastname wird so lange nicht erneut angefragt. */
const GUEST_NAME_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const guestNameMisses = new Map<string, number>();

/** Nur für Tests: Negativ-Cache der Gastnamen leeren. */
export function resetGuestNameCacheForTests(): void {
  guestNameMisses.clear();
}

/** Lokaler Stand einer inquiries-Zeile (für die sparsame Nachlade-Auswahl). */
export interface LocalInquiryState {
  status: string;
  guest_name: string | null;
}

export interface EnrichDeps {
  /** v3-Einzel-/Stapelabruf (roh, mit money), höchstens 10 IDs je Guesty-Aufruf */
  getReservationsV3ByIds: (ids: string[]) => Promise<any[]>;
  /** guests-crud */
  getGuest: (guestId: string) => Promise<{ fullName?: string; firstName?: string } | null>;
}

export interface EnrichStats {
  moneyRequested: number;
  moneyFilled: number;
  moneySkippedByCap: number;
  guestFetched: number;
  guestFromLocal: number;
  guestSkippedByCap: number;
  enrichErrors: number;
}

function isoDateMinusDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * #1099: Die v3-Liste (search) liefert weder money noch guest. Ergänzt beides gezielt und
 * sparsam, damit die inquiries-Zeile wie mit der Legacy-Liste entsteht:
 * - money (aus dem v3-Einzelabruf, wertgleich zur Legacy-API; Stapel à 10 IDs) nur für neue
 *   Zeilen, geänderten Status, laufende/künftige Aufenthalte (Check-out ≥ heute − 7 Tage) oder
 *   alle beim täglichen Voll-Lauf (`fullMoneyRefresh`). Sonst bleibt der bekannte Preis per
 *   COALESCE im Upsert stehen.
 * - Gastname: aus der lokalen Zeile; nachgeladen (guests-crud) nur bei neuer Zeile, geändertem
 *   Status oder fehlendem/„Unknown"-Namen, je guestId höchstens einmal pro Lauf; ein
 *   Fehlschlag wird 24 h nicht wiederholt. Obergrenzen je Lauf (Rest im nächsten Lauf).
 * Wirft nicht: ein Nachladefehler lässt die Zeile ohne diese Felder (Upsert behält den Bestand).
 */
export async function enrichGuestyListReservations(
  reservations: any[],
  local: Map<string, LocalInquiryState>,
  deps: EnrichDeps,
  opts: { today: string; fullMoneyRefresh?: boolean; nowMs?: number },
): Promise<EnrichStats> {
  const stats: EnrichStats = {
    moneyRequested: 0, moneyFilled: 0, moneySkippedByCap: 0,
    guestFetched: 0, guestFromLocal: 0, guestSkippedByCap: 0, enrichErrors: 0,
  };
  const nowMs = opts.nowMs ?? Date.now();
  const moneyCutoff = isoDateMinusDays(opts.today, MONEY_REFRESH_PAST_DAYS);

  // money
  const moneyIds: string[] = [];
  for (const r of reservations) {
    if (!r?._id || r.money) continue;
    const prev = local.get(r._id);
    const checkOut: string | undefined =
      r.checkOutDateLocalized ?? (typeof r.checkOut === 'string' ? r.checkOut.slice(0, 10) : undefined);
    const wanted = opts.fullMoneyRefresh || !prev || prev.status !== r.status || (checkOut !== undefined && checkOut >= moneyCutoff);
    if (!wanted) continue;
    if (moneyIds.length >= MAX_MONEY_IDS_PER_RUN) { stats.moneySkippedByCap++; continue; }
    moneyIds.push(r._id);
  }
  if (moneyIds.length > 0) {
    stats.moneyRequested = moneyIds.length;
    try {
      const full = await deps.getReservationsV3ByIds(moneyIds);
      const byId = new Map<string, any>();
      for (const v of full ?? []) if (v?._id && v.money) byId.set(v._id, v.money);
      for (const r of reservations) {
        const m = byId.get(r?._id);
        if (m && !r.money) { r.money = m; stats.moneyFilled++; }
      }
    } catch (error) {
      stats.enrichErrors++;
      logger.warn({ error, count: moneyIds.length }, 'syncInquiries: money-Nachladen fehlgeschlagen (non-fatal), Preise bleiben auf Bestand');
    }
  }

  // Gastnamen
  const fetchedThisRun = new Map<string, string | null>();
  for (const r of reservations) {
    if (!r?._id || r.guest?.fullName || r.guest?.firstName) continue;
    const prev = local.get(r._id);
    const localName = prev?.guest_name && prev.guest_name !== 'Unknown' ? prev.guest_name : null;
    const refresh = !prev || prev.status !== r.status || !localName;
    const guestId: string | undefined = r.guestId;
    if (!refresh || !guestId) {
      if (localName) { r.guest = { fullName: localName }; stats.guestFromLocal++; }
      continue;
    }
    let name: string | null | undefined = fetchedThisRun.get(guestId);
    if (name === undefined) {
      const missAt = guestNameMisses.get(guestId);
      if (missAt !== undefined && nowMs - missAt < GUEST_NAME_NEGATIVE_TTL_MS) {
        name = null;
      } else if (stats.guestFetched >= MAX_GUEST_FETCHES_PER_RUN) {
        stats.guestSkippedByCap++;
        name = null;
      } else {
        stats.guestFetched++;
        try {
          const g = await deps.getGuest(guestId);
          name = g?.fullName || g?.firstName || null;
        } catch (error) {
          stats.enrichErrors++;
          logger.warn({ error, guestId }, 'syncInquiries: Gastname nicht abrufbar (non-fatal)');
          name = null;
        }
        if (name) guestNameMisses.delete(guestId);
        else guestNameMisses.set(guestId, nowMs);
        fetchedThisRun.set(guestId, name);
      }
    }
    if (name) r.guest = { fullName: name };
    else if (localName) { r.guest = { fullName: localName }; stats.guestFromLocal++; }
  }
  return stats;
}

function loadLocalInquiryStates(listingId: string): Map<string, LocalInquiryState> {
  const rows = getDatabase()
    .prepare('SELECT inquiry_id, status, guest_name FROM inquiries WHERE listing_id = ?')
    .all(listingId) as Array<{ inquiry_id: string; status: string; guest_name: string | null }>;
  return new Map(rows.map((r) => [r.inquiry_id, { status: r.status, guest_name: r.guest_name }]));
}

const realEnrichDeps: EnrichDeps = {
  getReservationsV3ByIds: (ids) => guestyClient.getReservationsV3ByIds(ids),
  getGuest: (guestId) => guestyClient.getGuest(guestId),
};

/**
 * Sync all inquiries and reservations from Guesty API
 *
 * Fetches ALL reservation statuses (inquiry, confirmed, reserved, canceled, declined)
 * to enable accurate conversion rate tracking.
 * #1099: Liste über v3 search (getReservationsPage), money und Gastname gezielt nachgeladen
 * (enrichGuestyListReservations); `fullMoneyRefresh` (täglicher Force-Lauf) lädt money für alle.
 * Logzeile „Inquiry sync completed successfully" trägt `guestyRequests` (Aufrufe dieses Laufs).
 */
export async function syncInquiries(
  listingId: string,
  opts: { fullMoneyRefresh?: boolean } = {},
): Promise<SyncInquiriesResult> {
  const startTime = Date.now();
  const countersBefore = guestyClient.getRequestCounters?.();

  try {
    logger.info({ listingId }, 'Starting inquiry sync from Guesty API');

    // Fetch ALL reservations (ohne Statusfilter = alle Status, siehe Client).
    // WICHTIG (#271, Fall Kemkes): mit Paginierung — ohne sie blieben Listings
    // mit >100 historischen Reservierungen bei den ältesten 100 hängen und neue
    // Buchungen/Stornos kamen nie in der inquiries-Tabelle an (Geister-Events
    // im Google-Kalender, weil getCancelledReservationIds den Storno nie sah).
    const pageSize = 100;
    const maxPages = 50; // Sicherheitsgrenze (5.000 Reservierungen pro Listing)
    const allReservations: any[] = [];
    for (let page = 0; page < maxPages; page++) {
      const { results, hasMore } = (await guestyClient.getReservationsPage({
        listingId,
        limit: pageSize,
        ...(page > 0 ? { skip: page * pageSize } : {}),
      })) ?? { results: [], hasMore: false };
      allReservations.push(...results);
      if (!hasMore) break;
      if (page === maxPages - 1) {
        logger.warn({ listingId, fetched: allReservations.length }, 'syncInquiries: Seiten-Sicherheitsgrenze erreicht — Liste evtl. unvollständig');
      }
    }

    logger.info(
      { count: allReservations.length, listingId },
      'Fetched reservations from Guesty API'
    );

    const enrich = await enrichGuestyListReservations(
      allReservations,
      loadLocalInquiryStates(listingId),
      realEnrichDeps,
      { today: new Date().toISOString().slice(0, 10), fullMoneyRefresh: opts.fullMoneyRefresh },
    );

    // Count by status
    const inquiries = allReservations.filter((r: any) => r.status === 'inquiry');
    const confirmed = allReservations.filter((r: any) =>
      r.status === 'confirmed' || r.status === 'reserved'
    );

    // Upsert to inquiries table (#1234: gemeinsamer Mapper/Upsert mit dem Einzelabruf beim Eingang)
    upsertGuestyInquiries(allReservations);

    const duration = Date.now() - startTime;
    // #1099 (AK6): Guesty-Aufrufe dieses Laufs (alle HTTP-Versuche inkl. Retries)
    const guestyRequests =
      countersBefore && guestyClient.getRequestCounters
        ? diffRequestCounters(guestyClient.getRequestCounters(), countersBefore).total
        : null;

    logger.info(
      {
        listingId,
        totalCount: allReservations.length,
        inquiriesCount: inquiries.length,
        confirmedCount: confirmed.length,
        duration,
        guestyRequests,
        fullMoneyRefresh: !!opts.fullMoneyRefresh,
        ...enrich,
      },
      'Inquiry sync completed successfully'
    );
    if (guestyRequests !== null && guestyRequests >= 100) {
      logger.warn({ listingId, guestyRequests }, 'Inquiry sync: Guesty-Aufrufe je Lauf am Minutenlimit (100)');
    }

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
