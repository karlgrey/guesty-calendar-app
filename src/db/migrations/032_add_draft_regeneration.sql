-- Migration: Stale-Draft-Regeneration (#699, 25.09.2026, Fall Farmhouse-Entwurf So→Mo)
-- Created: 2026-09-25
--
-- Ein KI-Entwurf, den Micha im Admin-UI öffnet, war teils Stunden/Tage alt (Fall: Entwurf
-- von So 15:34 wurde erst Mo gesendet — der Zeitbezug "schönen Sonntag" passte nicht mehr).
-- GET /admin/messages/:threadId generiert einen zu alten pending-LLM-Entwurf jetzt beim
-- Öffnen still neu (stale-draft-regen.ts) — derselbe Datensatz (draftId bleibt gleich, der
-- Push-Watcher dedupliziert darüber), nicht wie der "Neu generieren"-Button ein neuer.
--
-- regenerated_at: Zeitpunkt der letzten ERFOLGREICHEN Neugenerierung (Referenzzeit fürs
-- "wie alt ist der Entwurf" statt created_at, sobald einmal neu generiert wurde).
-- regen_attempted_at: Zeitpunkt des letzten Versuchs (Erfolg ODER Fehlschlag) — Drossel,
-- damit wiederholtes Öffnen desselben Threads nicht bei jedem Aufruf erneut ans LLM geht.
-- previous_body/previous_body_at: Text und Entstehungszeit der Vorversion, damit Micha im
-- UI nachvollziehen kann, was ersetzt wurde (previous_body_at = deren regenerated_at bzw.
-- created_at, je nachdem was zuvor galt).
ALTER TABLE message_drafts ADD COLUMN regenerated_at TEXT;
ALTER TABLE message_drafts ADD COLUMN regen_attempted_at TEXT;
ALTER TABLE message_drafts ADD COLUMN previous_body TEXT;
ALTER TABLE message_drafts ADD COLUMN previous_body_at TEXT;
