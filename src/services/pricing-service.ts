/**
 * Preise und Mindestnächte je Tag lesen und schreiben (#1299), Anbieter-Adapter für
 * GET/PUT /api/agent/pricing/:slug. Die reine Planlogik liegt in pricing-plan.ts.
 *
 * Guesty (Farmhouse, U19): Lesen `getCalendar`, Schreiben `setListingCalendarPricing`
 * (Open API PUT /availability-pricing/api/calendar/listings/{id}, endDate inklusiv, ohne status),
 * je Lauf ein PUT, sequentiell (Guesty: nicht parallel auf dasselbe Listing).
 * Hostex (Bootshaus, Schilderwerkstatt): Preise und min_stay hängen am KANAL-Listing
 * (channels[0], Airbnb-ID), nicht an der property_id. Lesen `POST /v3/listings/calendar`,
 * Schreiben `POST /v3/listings/prices` bzw. `/restrictions` (Live-Probe 20.11.2026: end_date
 * inklusive, nach ≤ 6 s sichtbar). closed_on_arrival/closed_on_departure werden beim
 * Restriktions-Schreiben mit dem Ist-Wert des Tages explizit mitgesendet (die Sonntags-Anreise-
 * sperre darf nicht verloren gehen; ob Hostex fehlende Felder erhält, ist nur für
 * false-Werte belegt).
 */

import type { PropertyConfig } from '../config/properties.js';
import { getListingId } from '../config/properties.js';
import { guestyClient } from './guesty-client.js';
import { getHostexClient } from './hostex-client.js';
import { classifyGuestyDay } from './guesty-availability.js';
import { addDays, groupWriteRuns, type PricingChange, type PricingDay } from './pricing-plan.js';
import { ValidationError } from '../utils/errors.js';

export interface ProviderPricingDay extends PricingDay {
  closedOnArrival: boolean;
  closedOnDeparture: boolean;
}

export interface PricingTarget {
  property: PropertyConfig;
  provider: 'guesty' | 'hostex';
  /** Guesty-Listing-ID bzw. Hostex-property_id (wie in properties.json) */
  listingId: string;
  /** nur Hostex: Kanal-Listing, an dem Preis und min_stay hängen */
  channel?: { channelType: string; listingId: string };
}

export interface WrittenRun {
  from: string;
  to: string;
  nights: number;
  price?: number;
  minNights?: number;
}

/** Hostex-Reservierungsstatus, die einen Tag belegen (wait_accept: Anfrage offen, vorsichtshalber). */
const HOSTEX_OCCUPYING = new Set(['accepted', 'wait_pay', 'wait_accept']);
/** Rückblick für Hostex-Reservierungen, die vor `from` einchecken und hineinreichen. */
const HOSTEX_LOOKBACK_DAYS = 120;

export async function resolvePricingTarget(property: PropertyConfig): Promise<PricingTarget> {
  if (property.provider !== 'guesty' && property.provider !== 'hostex') {
    throw new ValidationError(`property ${property.slug} hat Provider "${property.provider}" — Preise nur für provider=guesty|hostex`);
  }
  const listingId = getListingId(property);
  if (property.provider === 'guesty') return { property, provider: 'guesty', listingId };

  const all = await getHostexClient().getProperties();
  const hp = all.find((p) => String(p.id) === listingId);
  const ch = hp?.channels?.[0];
  if (!ch) throw new ValidationError(`Hostex-Property ${listingId} (${property.slug}) hat kein Kanal-Listing`);
  return { property, provider: 'hostex', listingId, channel: { channelType: ch.channel_type, listingId: ch.listing_id } };
}

/** Tage from..to (inklusive) mit Preis, Mindestnächten und Belegung; sortiert. */
export async function readPricingDays(
  target: PricingTarget, from: string, to: string, todayBerlin: string,
): Promise<ProviderPricingDay[]> {
  if (target.provider === 'guesty') {
    const raw = await guestyClient.getCalendar(target.listingId, from, to);
    return raw.map((d) => {
      const c = classifyGuestyDay(d);
      const occupied = c.blockType === 'reservation' || c.blockType === 'hold' || c.blockType === 'late-checkout';
      return {
        date: c.date,
        price: typeof d.price === 'number' ? d.price : null,
        minNights: typeof d.minNights === 'number' ? d.minNights : null,
        occupied,
        ...(occupied ? { occupiedReason: guestyOccupiedReason(c.blockType, c.reservationId) } : {}),
        closedOnArrival: d.cta === true,
        closedOnDeparture: d.ctd === true,
      };
    }).filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  }

  // Hostex: Kanalkalender beginnt frühestens heute (Vergangenheit liefert der Kalender nicht).
  const start = from < todayBerlin ? todayBerlin : from;
  if (start > to) return [];
  const client = getHostexClient();
  const channel = target.channel!;
  const cal = await client.getListingCalendars({
    startDate: start, endDate: to,
    listings: [{ channel_type: channel.channelType, listing_id: channel.listingId }],
  });
  const listing = cal.listings.find((l) => l.listing_id === channel.listingId);
  const reservations = (await client.getReservations({
    propertyId: target.listingId,
    startCheckIn: addDays(start, -HOSTEX_LOOKBACK_DAYS),
    endCheckIn: to,
  })).filter((r) => HOSTEX_OCCUPYING.has(r.status));

  return (listing?.calendar ?? []).map((d) => {
    const res = reservations.find((r) => r.check_in_date <= d.date && d.date < r.check_out_date);
    return {
      date: d.date,
      price: typeof d.price === 'number' ? d.price : null,
      minNights: typeof d.restrictions?.min_stay_on_arrival === 'number' ? d.restrictions.min_stay_on_arrival : null,
      occupied: !!res,
      ...(res ? { occupiedReason: `Reservierung ${res.reservation_code} (${res.status}) — nicht angefasst` } : {}),
      closedOnArrival: d.restrictions?.closed_on_arrival === true,
      closedOnDeparture: d.restrictions?.closed_on_departure === true,
    };
  }).filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}

function guestyOccupiedReason(blockType: string | null, reservationId?: string): string {
  const id = reservationId ? ` ${reservationId}` : '';
  if (blockType === 'hold') return `Hold${id} — nicht angefasst`;
  if (blockType === 'late-checkout') return 'Folgetag-Block nach Late-Checkout — nicht angefasst';
  return `Reservierung${id} — nicht angefasst`;
}

/** Schreibläufe, wie sie an den Anbieter gehen (für dryRun-Vorschau und Vollzug gleich). */
export function planWriteRuns(target: PricingTarget, changes: PricingChange[]): WrittenRun[] {
  if (target.provider === 'guesty') {
    return groupWriteRuns(changes.map((c) => ({
      date: c.date,
      payload: { ...(c.price ? { price: c.price.new } : {}), ...(c.minNights ? { minNights: c.minNights.new } : {}) },
    }))).map((r) => ({ from: r.from, to: r.to, nights: r.nights, ...r.payload }));
  }
  const priceRuns = groupWriteRuns(changes.filter((c) => c.price).map((c) => ({ date: c.date, payload: { price: c.price!.new } })));
  const minRuns = groupWriteRuns(changes.filter((c) => c.minNights).map((c) => ({ date: c.date, payload: { minNights: c.minNights!.new } })));
  return [
    ...priceRuns.map((r) => ({ from: r.from, to: r.to, nights: r.nights, price: r.payload.price })),
    ...minRuns.map((r) => ({ from: r.from, to: r.to, nights: r.nights, minNights: r.payload.minNights })),
  ];
}

/** Läufe je Hostex-Schreibaufruf (deckt sich mit der Stapelgröße im Client). */
const HOSTEX_WRITE_BATCH = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface WriteOutcome {
  written: WrittenRun[];
  /** gesetzt, wenn ein Schreibaufruf scheiterte; `written` enthält dann die schon erfolgten Läufe */
  error?: unknown;
}

/**
 * Änderungen schreiben. Wirft nicht: Teil-Erfolge stehen in `written`, der Fehler in `error`.
 * `days` liefert für Hostex die Ist-Werte von closed_on_arrival/closed_on_departure.
 */
export async function writePricingChanges(
  target: PricingTarget, changes: PricingChange[], days: ProviderPricingDay[],
): Promise<WriteOutcome> {
  const written: WrittenRun[] = [];
  try {
    if (target.provider === 'guesty') {
      for (const run of planWriteRuns(target, changes)) {
        await guestyClient.setListingCalendarPricing(target.listingId, {
          startDate: run.from, endDate: run.to,
          ...(run.price !== undefined ? { price: run.price } : {}),
          ...(run.minNights !== undefined ? { minNights: run.minNights } : {}),
        });
        written.push(run);
      }
      return { written };
    }

    const client = getHostexClient();
    const channel = target.channel!;
    const priceRuns = groupWriteRuns(changes.filter((c) => c.price).map((c) => ({ date: c.date, payload: { price: c.price!.new } })));
    // Je Stapel ein Aufruf und danach sofort verbucht: scheitert ein späterer Stapel, nennt
    // `written` genau die schon angenommenen Läufe (sonst fehlten sie in Antwort, Log und Refresh).
    for (const part of chunk(priceRuns, HOSTEX_WRITE_BATCH)) {
      await client.updateListingPrices({
        channelType: channel.channelType, listingId: channel.listingId,
        prices: part.map((r) => ({ startDate: r.from, endDate: r.to, price: r.payload.price })),
      });
      written.push(...part.map((r) => ({ from: r.from, to: r.to, nights: r.nights, price: r.payload.price })));
    }
    const byDate = new Map(days.map((d) => [d.date, d]));
    const minChanges = changes.filter((c) => c.minNights);
    const minRuns = groupWriteRuns(minChanges.map((c) => {
      const d = byDate.get(c.date);
      return {
        date: c.date,
        payload: {
          minNights: c.minNights!.new,
          closedOnArrival: d?.closedOnArrival ?? false,
          closedOnDeparture: d?.closedOnDeparture ?? false,
        },
      };
    }));
    for (const part of chunk(minRuns, HOSTEX_WRITE_BATCH)) {
      await client.updateListingRestrictions({
        channelType: channel.channelType, listingId: channel.listingId,
        restrictions: part.map((r) => ({
          startDate: r.from, endDate: r.to,
          minStayOnArrival: r.payload.minNights,
          closedOnArrival: r.payload.closedOnArrival,
          closedOnDeparture: r.payload.closedOnDeparture,
        })),
      });
      // für die Antwort wieder auf Zielwert-Läufe verdichten (cta/ctd sind nur Erhaltung);
      // die Läufe sind sortiert und überschneidungsfrei, der Stapel deckt also genau dieses Datumsfenster.
      const first = part[0].from;
      const last = part[part.length - 1].to;
      written.push(...groupWriteRuns(minChanges.filter((c) => c.date >= first && c.date <= last)
        .map((c) => ({ date: c.date, payload: { minNights: c.minNights!.new } })))
        .map((r) => ({ from: r.from, to: r.to, nights: r.nights, minNights: r.payload.minNights })));
    }
    return { written };
  } catch (error) {
    return { written, error };
  }
}

/** Tage, deren Ist-Stand nach dem Schreiben noch nicht dem Zielwert entspricht. */
export function findNotApplied(changes: PricingChange[], after: PricingDay[]): string[] {
  const byDate = new Map(after.map((d) => [d.date, d]));
  return changes.filter((c) => {
    const d = byDate.get(c.date);
    if (!d) return true;
    if (c.price && d.price !== c.price.new) return true;
    if (c.minNights && d.minNights !== c.minNights.new) return true;
    return false;
  }).map((c) => c.date);
}
