/**
 * Buchungsanfrage-Erkennung (#697 Fall Anika Farmhouse; erweitert #702 Fall Anika Folgenachricht).
 *
 * Guesty hängt an neue Buchungsanfragen einen System-Post — "New guest inquiry" (Inquiry,
 * ohne Code) bzw. "New guest reservation request <CODE>" (Request-to-Book, mit Airbnb-Code) —
 * ZEITLICH NACH der auslösenden Gastnachricht (verifiziert 21.09.2026, Fall Anika: Gastnachricht
 * 20:34:58Z, System-Post 20:35:04Z).
 *
 * findOpenBookingRequest() erkennt, ob eine Buchungsanfrage in DIESEM Thread noch OFFEN ist —
 * unabhängig vom Judge-Modell, damit die Kategorie 'buchungsanfrage' nicht allein von der
 * LLM-Klassifikation abhängt (Kategorie-Override + Task-Anlage, siehe runner.ts). Anders als die
 * ursprüngliche #697-Fassung (die NUR einen System-Post UNMITTELBAR NACH der letzten
 * Gastnachricht als Trigger zählte) durchsucht diese Funktion den GESAMTEN Thread-Verlauf: ein
 * System-Post kann beliebig weit zurückliegen, solange die verknüpfte Reservierung/Inquiry noch
 * NICHT bestätigt ist (reservationStatus) — Fall Anika #702: ihre Antwort auf unsere Rückfrage
 * (Anlass "Geburtstagsrunde") kam mehrere Nachrichten NACH dem System-Post und landete ohne diese
 * Erweiterung fälschlich in der Kategorie sonderwunsch statt buchungsanfrage (Kommentar #697/2209).
 * Ist die Reservierung/Inquiry bestätigt, gilt kein Vorrang mehr — normale Bewertung.
 *
 * Reine Funktion, kein I/O — `messages` liegt chronologisch aufsteigend vor (wie von
 * getMessagesByThread geliefert). Airbnb erwartet bei BEIDEN Post-Arten eine Antwort binnen 24h
 * — die Frist wird deshalb für inquiry UND request_to_book aus dem (ggf. länger zurückliegenden)
 * System-Post-Zeitpunkt berechnet und bleibt über Folgenachrichten hinweg stabil (kein Neustart
 * der Frist bei jeder weiteren Gastnachricht).
 */
import type { Message } from '../types/messages.js';
import { ACTIVE_RESERVATION_STATUSES } from '../repositories/reservation-repository.js';

export type BookingRequestKind = 'inquiry' | 'request_to_book';

export interface BookingRequestContext {
  requestKind: BookingRequestKind;
  /** messages.id des auslösenden System-Posts — Idempotenz-Schlüssel für die Task-Anlage. */
  systemMessageId: string;
  systemMessageSentAt: string; // ISO
  /** systemMessageSentAt + 24h, ISO-8601 UTC. */
  platformDeadlineAt: string;
}

const REQUEST_TO_BOOK_PATTERN = /New guest reservation request/i;
const INQUIRY_PATTERN = /New guest inquiry/i;
const DEADLINE_HOURS = 24;

const CONFIRMED_STATUSES: readonly string[] = ACTIVE_RESERVATION_STATUSES;

/**
 * Findet den jüngsten System-Post im GESAMTEN Thread, der eine noch offene Guesty-
 * Buchungsanfrage signalisiert. null, wenn die verknüpfte Reservierung/Inquiry bereits
 * bestätigt ist (reservationStatus ∈ {confirmed, reserved}, deckungsgleich mit
 * reservation-repository.ts/draft-service.ts) oder kein passender System-Post im Thread steht
 * (z. B. eine normale Frage ohne Guesty-Inquiry-Post).
 */
export function findOpenBookingRequest(
  messages: Message[],
  reservationStatus: string | null,
): BookingRequestContext | null {
  if (reservationStatus && CONFIRMED_STATUSES.includes(reservationStatus)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== 'system') continue;
    let requestKind: BookingRequestKind | null = null;
    if (REQUEST_TO_BOOK_PATTERN.test(m.body)) requestKind = 'request_to_book';
    else if (INQUIRY_PATTERN.test(m.body)) requestKind = 'inquiry';
    if (!requestKind) continue;

    const sentAt = m.sent_at;
    const deadlineMs = Date.parse(sentAt) + DEADLINE_HOURS * 60 * 60 * 1000;
    return {
      requestKind,
      systemMessageId: m.id,
      systemMessageSentAt: sentAt,
      platformDeadlineAt: new Date(deadlineMs).toISOString(),
    };
  }
  return null;
}
