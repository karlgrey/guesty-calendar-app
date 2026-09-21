-- Migration: Buchungsanfragen als eigene Judge-Kategorie (#697, Bauauftrag Standup
-- 21.09.2026, Fall Anika Farmhouse)
-- Created: 2026-09-21
--
-- request_kind + platform_deadline_at persistieren die mechanisch erkannte Airbnb-
-- Buchungsanfrage (System-Post "New guest inquiry"/"New guest reservation request", siehe
-- src/services/booking-request.ts) am Draft — die Airbnb-24h-Antwortfrist. Der SmartTasks-Task
-- für die Buchungsanfrage nutzt bewusst die BESTEHENDEN Spalten smarttasks_task_id/
-- smarttasks_task_guest_message_id aus Migration 029 (Idempotenz-Schlüssel wird für diesen Fall
-- die Id des System-Posts statt einer Gastnachricht — dieselbe Spalte, gleiche Semantik "Id der
-- Nachricht, die diesen Task ausgelöst hat").
ALTER TABLE message_drafts ADD COLUMN request_kind TEXT;          -- 'inquiry' | 'request_to_book' | NULL
ALTER TABLE message_drafts ADD COLUMN platform_deadline_at TEXT;  -- ISO-8601 UTC | NULL
