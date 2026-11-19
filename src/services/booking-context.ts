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
import { getAirbnbGuestPriceConfig } from '../config/properties.js';
import { computeStayFacts, formatStayFactsSentence, formatDiscountConditionSentence, type DiscountCondition } from './counter-offer.js';
import { getPropertyForThread } from '../utils/thread-property.js';
import { resolveGuestPrice, channelName, GUEST_TOTAL_MARKER, type AirbnbGuestPriceRates, type GuestPrice } from './guest-price.js';

/** ISO/localized date (YYYY-MM-DD…) → German TT.MM.JJJJ. */
function deDate(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** 3118.05, 'EUR' → "3.118,05 EUR" (Währung fehlt → nur die Zahl). */
function formatMoney(amount: number, currency: string | null): string {
  const n = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return currency ? `${n} ${currency}` : n;
}

/** #1242: konfigurierte Sätze für den berechneten Gastbetrag; Fehler beim Laden → keine Sätze. */
function configuredRates(): AirbnbGuestPriceRates | undefined {
  try {
    return getAirbnbGuestPriceConfig();
  } catch {
    return undefined;
  }
}

export interface BookingContextOptions {
  /** #1242: Sätze für die Rückrechnung; weggelassen = aus properties.json, null = keine. */
  rates?: AirbnbGuestPriceRates | null;
  /** #1243: Rabatt-Bedingung des Objekts; weggelassen = properties.json `airbnbDiscount` des Thread-Objekts, null = keine. */
  discountRule?: DiscountCondition | null;
}

function discountRuleFrom(thread: MessageThread, opts: BookingContextOptions | undefined): DiscountCondition | null {
  if (opts && 'discountRule' in opts) return opts.discountRule ?? null;
  try {
    return getPropertyForThread(thread)?.airbnbDiscount ?? null;
  } catch {
    return null;
  }
}

function ratesFrom(opts: BookingContextOptions | undefined): AirbnbGuestPriceRates | undefined {
  if (opts && 'rates' in opts) return opts.rates ?? undefined;
  return configuredRates();
}

/**
 * #1242: Preis-Teil der Anfrage-Zeile im Entwurfs-Kontext. Nennt den Betrag, den der Gast in Airbnb
 * sieht, mit Steuer als Hauptwert (Entscheidung Micha 19.11.2026: Gäste rechnen mit Steuer).
 * Nie die Auszahlung, nie Gebührensatz oder Rechenweg (sonst wäre die Auszahlung ablesbar).
 */
function contextPricePart(p: GuestPrice | null): string {
  if (!p) return '';
  switch (p.kind) {
    case 'estimated':
      return (
        `, ${GUEST_TOTAL_MARKER} laut ${p.channel} ca. ${formatMoney(p.inclTax, p.currency)} inkl. Steuern ` +
        `(berechnet, ungefähr; ohne Steuern ca. ${formatMoney(p.exclTax, p.currency)})`
      );
    case 'actual':
      return `, ${GUEST_TOTAL_MARKER} laut ${p.channel} ${formatMoney(p.total, p.currency)} inkl. Steuern`;
    case 'accommodation':
      return `, Übernachtungspreis laut ${p.channel} ${formatMoney(p.amount, p.currency)} (ohne Reinigung, Steuern und Gebühren)`;
  }
}

/**
 * Builds a short "what the platform already knows about this booking" block
 * for the draft-generation system prompt. Returns null when the thread isn't
 * linked to a reservation or inquiry (nothing to say).
 */
export function buildBookingContext(thread: MessageThread, opts?: BookingContextOptions): string | null {
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
    const inquiry = getInquiryWithMoneyById(thread.inquiry_id);
    if (!inquiry || !inquiry.check_in || !inquiry.check_out) return null;

    const checkIn = deDate(inquiry.check_in);
    const checkOut = deDate(inquiry.check_out);
    const nights = nightsBetween(inquiry.check_in, inquiry.check_out);
    // Guesty-Anfragen-Sync schreibt `guestsCount || 0` — 0 heißt dort "unbekannt" (#1234).
    const guests = positiveOrNull(inquiry.guests_count) != null ? `${inquiry.guests_count} Personen` : 'Personenzahl unbekannt';
    // #1244: Der Einzelabruf schreibt auch schon bestätigte/reservierte Reservierungen nach `inquiries`,
    // solange die reservations-Zeile fehlt. Das ist eine Buchung, keine offene Anfrage: kein Zusatz
    // "noch nicht bestätigt", keine Preis-/Rabatt-/Gegenangebot-Einordnung (gilt nur für offene Anfragen).
    // Format "Zeitraum TT.MM.JJJJ–TT.MM.JJJJ" bleibt für today-facts.ts parsebar.
    const bookedLabel = inquiry.status === 'confirmed' ? 'Buchung (bestätigt)'
      : inquiry.status === 'reserved' ? 'Buchung (reserviert)' : null;
    if (bookedLabel) {
      return `${bookedLabel}: Zeitraum ${checkIn}–${checkOut}, ${nights} Nächte, ${guests} — Daten stammen aus dem Einzelabruf der Buchung.`;
    }
    // #1234/#1242 (Fall Daniel): Gastbetrag mitgeben, damit der Entwurf ein Gegenangebot des Gasts
    // einordnen kann. Bei Airbnb-Anfragen über Guesty ist total_price = host_payout = Netto-Auszahlung
    // — deshalb nie total_price blind nennen, sondern nach price_basis (resolveGuestPrice).
    const price = contextPricePart(resolveGuestPrice(inquiry, ratesFrom(opts)));

    // #1243: Anfrage-Zeitpunkt und Wochentage der Nächte (Grundlage der Rabatt-Einordnung). Steht NACH
    // dem Zeitraum-Teil, damit today-facts.ts das Format "Zeitraum TT.MM.JJJJ–TT.MM.JJJJ" unverändert parst.
    const stayFacts = computeStayFacts(inquiry.check_in, inquiry.check_out, inquiry.created_at_guesty);
    const stay = formatStayFactsSentence(stayFacts);
    // #1243: nur bei Objekten mit Rabatt-Linie (Farmhouse) — die Bedingung wird hier ausgewertet, der
    // Entwurf prüft sie nicht selbst (Live-Test: Sonnet bot sonst trotz nicht erfüllter Bedingung an).
    // #1243 (Prüfer-Befund 5): die Linie gilt nur für Airbnb-Anfragen — am Kanal der Anfrage, nicht nur am Objekt.
    const rule = channelName(inquiry.source) === 'Airbnb' ? discountRuleFrom(thread, opts) : null;
    const condition = rule ? formatDiscountConditionSentence(stayFacts, rule) : '';
    const tail = [stay, condition].filter(Boolean).join(' ');

    return (
      `Buchungsanfrage (noch nicht bestätigt): Zeitraum ${checkIn}–${checkOut}, ${nights} Nächte, ${guests}${price} ` +
      `— Daten stammen aus der Anfrage selbst.${tail ? ` ${tail}` : ''}`
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
 * totalPrice = reservations/inquiries.total_price (Guesty: fareAccommodationAdjusted — bei
 * Airbnb-ANFRAGEN die Netto-Auszahlung, #1242; Hostex: total_rate).
 * guestPrice (#1242, nur Anfragen): Gastbetrag wie im Entwurfs-Kontext (resolveGuestPrice).
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
  /** #1242: Gastbetrag laut Plattform (nur bei kind 'inquiry', sonst null) */
  guestPrice: GuestPrice | null;
  /** #1243: Zeitpunkt der Anfrage (ISO, nur bei kind 'inquiry'; sonst/unbekannt null) */
  requestedAt: string | null;
}

/** Guesty-Anfragen-Sync schreibt `guestsCount || 0` — 0 Personen heißt dort "unbekannt". */
function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && n > 0 ? n : null;
}

export function resolveThreadBookingSummary(thread: MessageThread, opts?: BookingContextOptions): ThreadBookingSummary | null {
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
        guestPrice: null,
        requestedAt: null,
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
        guestPrice: resolveGuestPrice(inq, ratesFrom(opts)),
        requestedAt: inq.created_at_guesty,
      };
    }
  }
  return null;
}
