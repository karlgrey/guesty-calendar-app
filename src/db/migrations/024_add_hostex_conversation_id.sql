-- Migration: Add hostex_conversation_id to inquiries
-- Created: 2026-08-20
-- Description: #441 Root-Cause-Fix — Hostex message threads never carried
-- reservation_status (message-mapper.ts set it hard to null), so the #440
-- Kanal-/Status-Fakten-Block in the draft generator treated ALL Hostex-Airbnb
-- threads (Bootshaus, Alte Schilderwerkstatt) as permanently "NICHT bestätigt",
-- withholding links (Hausordnung etc.) even after a confirmed booking.
--
-- Guesty needs no equivalent: its conversation payload embeds
-- meta.reservations[].status directly. Hostex's conversation DETAIL carries no
-- reservation status at all — but HostexReservation.conversation_id (from
-- GET /v3/reservations) links a reservation back to its conversation. We
-- persist that link on the `inquiries` row (the superset table, written for
-- ALL Hostex statuses incl. cancelled/declined — unlike `reservations`, which
-- only holds active bookings) so sync-hostex-messages.ts can resolve
-- reservation_status via a local lookup, analogous to the Guesty schiene.

ALTER TABLE inquiries ADD COLUMN hostex_conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_inquiries_hostex_conversation_id ON inquiries(hostex_conversation_id);
