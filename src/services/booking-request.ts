/**
 * Buchungsanfrage-Erkennung (#697, Bauauftrag Standup 21.09.2026, Fall Anika Farmhouse).
 *
 * Guesty hängt an neue Buchungsanfragen einen System-Post — "New guest inquiry" (Inquiry,
 * ohne Code) bzw. "New guest reservation request <CODE>" (Request-to-Book, mit Airbnb-Code) —
 * ZEITLICH NACH der Gastnachricht (verifiziert 21.09.2026, Fall Anika: Gastnachricht 20:34:58Z,
 * System-Post 20:35:04Z). Diese Funktion erkennt genau das: einen solchen System-Post NACH der
 * letzten Gastnachricht im Thread — unabhängig vom Judge-Modell, damit die Kategorie
 * 'buchungsanfrage' nicht allein von der LLM-Klassifikation abhängt (Kategorie-Override, siehe
 * runner.ts). Reine Funktion, kein I/O — `messages` liegt chronologisch aufsteigend vor (wie von
 * getMessagesByThread geliefert).
 *
 * Airbnb erwartet bei BEIDEN Post-Arten eine Antwort binnen 24h — die Frist wird deshalb für
 * inquiry UND request_to_book aus dem System-Post-Zeitpunkt berechnet.
 */
import type { Message } from '../types/messages.js';

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

/**
 * Findet den jüngsten System-Post nach der letzten Gastnachricht, der eine Guesty-
 * Buchungsanfrage signalisiert. null, wenn keine Gastnachricht vorliegt oder kein passender
 * System-Post danach folgt (z. B. eine normale Frage ohne Guesty-Inquiry-Post).
 */
export function detectBookingRequestContext(messages: Message[]): BookingRequestContext | null {
  let lastInboundIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].direction === 'inbound') lastInboundIdx = i;
  }
  if (lastInboundIdx === -1) return null;

  for (let i = messages.length - 1; i > lastInboundIdx; i--) {
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
