/**
 * Booking Context (ticket #364)
 *
 * The messaging bot was re-asking guests for arrival/departure dates it
 * already had — draft-service.ts built its prompt from voice + property
 * facts + message texts only, never from the thread's own reservation_id /
 * inquiry_id link. This module turns that link into a short prompt block so
 * the model knows what the platform already knows and stops asking again.
 */
import { getReservationById, getInquiryById, getInquiryWithMoneyById } from '../repositories/reservation-repository.js';
import type { MessageThread } from '../types/messages.js';
import { nightsBetween } from '../utils/date.js';

/** ISO/localized date (YYYY-MM-DD…) → German TT.MM.JJJJ. */
function deDate(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Builds a short "what the platform already knows about this booking" block
 * for the draft-generation system prompt. Returns null when the thread isn't
 * linked to a reservation or inquiry (nothing to say).
 */
export function buildBookingContext(thread: MessageThread): string | null {
  if (thread.reservation_id) {
    const res = getReservationById(thread.reservation_id);
    // No early return on a miss: guesty inquiry threads carry the same Guesty
    // id in reservation_id AND inquiry_id, but until the booking is confirmed
    // only an inquiries row exists — fall through to the inquiry lookup below
    // (prod case Ezgi, 10.08.2026).
    if (res) {
      const checkIn = res.check_in_localized ? deDate(res.check_in_localized) : '?';
      const checkOut = res.check_out_localized ? deDate(res.check_out_localized) : '?';
      const status = thread.reservation_status ?? res.status;
      const guests = res.guests_count != null ? `${res.guests_count} Personen` : 'Personenzahl unbekannt';
      const code = res.confirmation_code ?? res.reservation_id;
      const label = status === 'confirmed' ? 'Bestätigte Buchung' : 'Buchung';

      // #698: das Format "Zeitraum TT.MM.JJJJ–TT.MM.JJJJ" (Gedankenstrich) wird von
      // today-facts.ts (parseBookingPeriod) geparst, um den HEUTE-Fakt/allowedWeekdays zu
      // berechnen — Format hier NICHT ändern, ohne today-facts.ts mitzuziehen ("?" statt eines
      // Datums ist dabei bewusst OK, matcht dort nicht und liefert konservativ null).
      return (
        `${label} (Status: ${status}): Zeitraum ${checkIn}–${checkOut}, ` +
        `${res.nights_count} Nächte, ${guests}, Konfirmationscode ${code}.`
      );
    }
  }

  if (thread.inquiry_id) {
    const inquiry = getInquiryById(thread.inquiry_id);
    if (!inquiry) return null;

    const checkIn = deDate(inquiry.check_in);
    const checkOut = deDate(inquiry.check_out);
    const nights = nightsBetween(inquiry.check_in, inquiry.check_out);
    const guests = inquiry.guests_count != null ? `${inquiry.guests_count} Personen` : 'Personenzahl unbekannt';

    return (
      `Buchungsanfrage (noch nicht bestätigt): Zeitraum ${checkIn}–${checkOut}, ${nights} Nächte, ${guests} ` +
      `— Daten stammen aus der Anfrage selbst.`
    );
  }

  return null;
}

/**
 * Kompaktes Zeitraum/Personen-Paar für die Buchungsanfrage-Task-Anlage (#697, booking-request-
 * task-service.ts — Titelformat "Airbnb-Anfrage <Vorname>: <Objekt> <Zeitraum>, <Personen> P.").
 * Dieselben reservation_id/inquiry_id-Lookups wie buildBookingContext, aber strukturiert statt
 * Prosa. null-Felder, wenn der Thread nicht verlinkt ist oder das jeweilige Feld nicht bekannt
 * ist — der Aufrufer lässt das dann im Titel einfach weg (Spec: "sonst weglassen").
 */
export function resolveBookingPeriod(thread: MessageThread): { periodLabel: string | null; guestsCount: number | null } {
  if (thread.reservation_id) {
    const res = getReservationById(thread.reservation_id);
    if (res) {
      const periodLabel = res.check_in_localized && res.check_out_localized
        ? `${deDate(res.check_in_localized)}–${deDate(res.check_out_localized)}`
        : null;
      return { periodLabel, guestsCount: res.guests_count ?? null };
    }
  }
  if (thread.inquiry_id) {
    const inquiry = getInquiryById(thread.inquiry_id);
    if (inquiry) {
      return {
        periodLabel: `${deDate(inquiry.check_in)}–${deDate(inquiry.check_out)}`,
        guestsCount: inquiry.guests_count ?? null,
      };
    }
  }
  return { periodLabel: null, guestsCount: null };
}

/**
 * #1187: strukturierte Buchungs-/Anfragedaten eines Threads für die Nachrichten-App
 * (Thread-Kopf + Listen-Badge). Reihenfolge wie resolveBookingPeriod: erst die Reservierung,
 * sonst die Anfrage — auch wenn reservation_id gesetzt ist, aber (Guesty-Anfrage) noch keine
 * reservations-Zeile existiert. Reine DB-Lesung, kein Live-Abruf (Rate-Limit).
 * null = Thread nicht verknüpft bzw. keine passende Zeile.
 *
 * Preis-Semantik wie die Sync-Mapper: hostPayout = Auszahlung an den Gastgeber;
 * totalPrice = reservations/inquiries.total_price (Guesty: fareAccommodationAdjusted,
 * Hostex: total_rate).
 */
export interface ThreadBookingSummary {
  kind: 'reservation' | 'inquiry';
  status: string | null;
  checkIn: string | null; // YYYY-MM-DD
  checkOut: string | null; // YYYY-MM-DD
  nights: number | null;
  guestsCount: number | null;
  adults: number | null;
  children: number | null;
  hostPayout: number | null;
  totalPrice: number | null;
  currency: string | null;
  platform: string | null;
}

/** Guesty-Anfragen-Sync schreibt `guestsCount || 0` — 0 Personen heißt dort "unbekannt". */
function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && n > 0 ? n : null;
}

export function resolveThreadBookingSummary(thread: MessageThread): ThreadBookingSummary | null {
  if (thread.reservation_id) {
    const res = getReservationById(thread.reservation_id);
    if (res) {
      const checkIn = res.check_in_localized?.slice(0, 10) ?? res.check_in?.slice(0, 10) ?? null;
      const checkOut = res.check_out_localized?.slice(0, 10) ?? res.check_out?.slice(0, 10) ?? null;
      return {
        kind: 'reservation',
        status: thread.reservation_status ?? res.status ?? null,
        checkIn,
        checkOut,
        nights: res.nights_count ?? (checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null),
        guestsCount: positiveOrNull(res.guests_count),
        adults: res.adults_count ?? null,
        children: res.children_count ?? null,
        hostPayout: res.host_payout ?? null,
        totalPrice: res.total_price ?? null,
        currency: res.currency ?? null,
        platform: res.platform ?? res.source ?? null,
      };
    }
  }
  const inquiryId = thread.inquiry_id ?? null;
  if (inquiryId) {
    const inq = getInquiryWithMoneyById(inquiryId);
    if (inq) {
      const checkIn = inq.check_in ? inq.check_in.slice(0, 10) : null;
      const checkOut = inq.check_out ? inq.check_out.slice(0, 10) : null;
      return {
        kind: 'inquiry',
        status: inq.status || null,
        checkIn,
        checkOut,
        nights: checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null,
        guestsCount: positiveOrNull(inq.guests_count),
        adults: null,
        children: null,
        hostPayout: inq.host_payout,
        totalPrice: inq.total_price,
        currency: inq.currency,
        platform: inq.source,
      };
    }
  }
  return null;
}
