/**
 * Zeit-Änderungen → Wanja-WhatsApp (#793).
 *
 * `reservation.timesChanged` ist hier eine lokale Funktion (kein Bus): die beiden
 * Schreibstellen des lokalen Stands — ETL-Upsert (sync-availability) und der Spiegel nach
 * PATCH (#792, mirrorReservationLocally) — rufen `upsertReservationsTrackingTimes` auf
 * (Vorher lesen → Upsert → Nachher lesen → detectTimesChange → notifyTimesChange).
 * Beide MÜSSEN einhängen: der Spiegel schreibt die Änderung schon vor dem nächsten ETL,
 * der ETL sähe sie sonst nie als Differenz. Dedupe (Migration 034) macht Doppelläufe
 * harmlos. Alles hier ist non-fatal — nie darf ein Benachrichtigungsproblem den Upsert
 * brechen.
 */
import { config } from '../config/index.js';
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getListingById } from '../repositories/listings-repository.js';
import { getReservationById, upsertReservationBatch } from '../repositories/reservation-repository.js';
import { getOverridesForReservations, type StayTimeOverride } from '../repositories/stay-time-override-repository.js';
import {
  claimTimesChangeNotification,
  releaseTimesChangeNotification,
} from '../repositories/times-change-notification-repository.js';
import { buildTimesChangeMessages, detectTimesChange, type TimesChange, type TimesSnapshot } from './reservation-times-change.js';
import { writeOutboxMessage } from './whatsapp-outbox.js';
import type { Reservation } from '../types/models.js';
import logger from '../utils/logger.js';

type ReservationInput = Omit<Reservation, 'id' | 'created_at' | 'updated_at'>;

export interface NotifierDeps {
  /** WA_OUTBOX_DIR — ohne Wert kein Versand (nur Log). */
  outboxDir: string | undefined;
  wanjaJid: string;
  findProperty: (listingId: string) => Pick<PropertyConfig, 'slug' | 'provider' | 'name' | 'shortCode'> | undefined;
  getListingTimes: (listingId: string) => { checkIn: string | null; checkOut: string | null };
  /** nur für Tests (YYYY-MM-DD) */
  today?: string;
  /** #799: Wanja-WhatsApp an? Default `config.timesChangeWhatsapp` (TIMES_CHANGE_WHATSAPP, Default aus). */
  whatsappEnabled?: boolean;
  /** #799: Override-Lookup für die Konflikt-Logzeile (Tests). Default `getOverridesForReservations`. */
  getOverrides?: (ids: string[]) => Map<string, StayTimeOverride>;
}

function defaultDeps(): NotifierDeps {
  return {
    outboxDir: config.waOutboxDir,
    wanjaJid: config.waWanjaJid,
    findProperty: (listingId) =>
      getAllProperties().find((p) => p.provider === 'guesty' && p.guestyPropertyId === listingId)
      ?? getAllProperties().find((p) => p.hostexPropertyId === listingId || p.airbnbListingId === listingId),
    getListingTimes: (listingId) => {
      const l = getListingById(listingId);
      return { checkIn: l?.check_in_time ?? null, checkOut: l?.check_out_time ?? null };
    },
  };
}

/** Anzeigename für die Crew: Farmhouse statt „Farmhouse Prasser", sonst Kürzel (U19). */
const OBJECT_LABELS: Record<string, string> = { farmhouse: 'Farmhouse' };
export function objectLabel(p: Pick<PropertyConfig, 'slug' | 'name' | 'shortCode'>): string {
  return OBJECT_LABELS[p.slug] ?? p.shortCode ?? p.name;
}

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

export function notifyTimesChange(change: TimesChange, deps: NotifierDeps = defaultDeps()): void {
  const property = deps.findProperty(change.listingId);
  if (!property || property.provider !== 'guesty') {
    logger.debug({ reservationId: change.reservationId, listingId: change.listingId }, 'timesChanged: kein Guesty-Objekt — keine Nachricht');
    return;
  }
  const times = deps.getListingTimes(change.listingId);
  const messages = buildTimesChangeMessages(change, {
    objectLabel: objectLabel(property),
    defaultCheckIn: hhmm(times.checkIn),
    defaultCheckOut: hhmm(times.checkOut),
  });

  for (const m of messages) {
    if (!deps.outboxDir) {
      logger.info(
        { reservationId: change.reservationId, field: m.field, value: m.value, text: m.text },
        'timesChanged: WA_OUTBOX_DIR nicht gesetzt — kein WhatsApp-Versand (nur Log)',
      );
      continue;
    }
    if (!claimTimesChangeNotification(change.reservationId, m.field, m.value)) {
      logger.debug({ reservationId: change.reservationId, field: m.field, value: m.value }, 'timesChanged: bereits benachrichtigt');
      continue;
    }
    try {
      const file = writeOutboxMessage(deps.outboxDir, deps.wanjaJid, m.text, change.reservationId);
      logger.info({ reservationId: change.reservationId, field: m.field, value: m.value, file }, 'timesChanged: WhatsApp in Outbox geschrieben');
    } catch (error) {
      releaseTimesChangeNotification(change.reservationId, m.field, m.value);
      logger.error({ error, reservationId: change.reservationId }, 'timesChanged: Outbox-Schreiben fehlgeschlagen');
    }
  }
}

function snapshotOf(id: string): TimesSnapshot | null {
  const r = getReservationById(id);
  return r
    ? {
        reservation_id: r.reservation_id, listing_id: r.listing_id, status: r.status,
        check_in: r.check_in, check_out: r.check_out,
        check_in_localized: r.check_in_localized, check_out_localized: r.check_out_localized,
        planned_arrival: r.planned_arrival, planned_departure: r.planned_departure,
      }
    : null;
}

/**
 * Upsert mit Änderungserkennung. `upsert` ist austauschbar (Tests); Standard ist der
 * Batch-Upsert des Repositories. Rückgabe wie `upsert`.
 */
export function upsertReservationsTrackingTimes(
  rows: ReservationInput[],
  upsert: (rows: ReservationInput[]) => number = upsertReservationBatch,
  deps?: NotifierDeps,
): number {
  let before = new Map<string, TimesSnapshot>();
  try {
    for (const r of rows) {
      const s = snapshotOf(r.reservation_id);
      if (s) before.set(r.reservation_id, s);
    }
  } catch (error) {
    logger.warn({ error }, 'timesChanged: Vorher-Stand nicht lesbar — keine Änderungserkennung');
    before = new Map();
  }

  const result = upsert(rows);

  // #799: Wanja-WhatsApp nur mit Flag (Default aus); Erkennung/Dedupe/Code bleiben.
  const whatsappEnabled = deps?.whatsappEnabled ?? config.timesChangeWhatsapp;
  const providerTimeChanged: TimesSnapshot[] = [];

  for (const [id, b] of before) {
    try {
      const a = snapshotOf(id);
      if (a && (time5(b.planned_arrival) !== time5(a.planned_arrival) || time5(b.planned_departure) !== time5(a.planned_departure))) {
        providerTimeChanged.push(a);
      }
      if (!whatsappEnabled) continue;
      // Listing-Standardzeit gleicher Weg wie in notifyTimesChange: fehlende planned_* = Standard (#793-Fix).
      const defaults = a ? (deps ?? defaultDeps()).getListingTimes(a.listing_id) : null;
      const change = a ? detectTimesChange(b, a, deps?.today, defaults) : null;
      if (change) notifyTimesChange(change, deps);
    } catch (error) {
      logger.warn({ error, reservationId: id }, 'timesChanged: Erkennung/Benachrichtigung fehlgeschlagen (non-fatal)');
    }
  }
  logOverrideConflicts(providerTimeChanged, deps);
  return result;
}

const time5 = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

/**
 * #799: Schreibt der Provider eigene `planned_*`, die vom Override abweichen (beide non-null,
 * ungleich), bleibt der Override führend; die Logzeile hilft beim Aufräumen. Keine Auto-Löschung.
 * Billig: nur für Reservierungen, deren planned_* sich in diesem Lauf geändert haben, EIN Lookup.
 */
function logOverrideConflicts(changed: TimesSnapshot[], deps?: NotifierDeps): void {
  if (changed.length === 0) return;
  try {
    const overrides = (deps?.getOverrides ?? getOverridesForReservations)(changed.map((s) => s.reservation_id));
    for (const s of changed) {
      const o = overrides.get(s.reservation_id);
      if (!o) continue;
      const fields = [
        { field: 'planned_arrival', override: time5(o.plannedArrival), provider: time5(s.planned_arrival) },
        { field: 'planned_departure', override: time5(o.plannedDeparture), provider: time5(s.planned_departure) },
      ];
      for (const f of fields) {
        if (f.override && f.provider && f.override !== f.provider) {
          logger.info({ reservationId: s.reservation_id, field: f.field, override: f.override, provider: f.provider }, 'override weicht vom Provider ab');
        }
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Override-Konfliktprüfung fehlgeschlagen (non-fatal)');
  }
}
