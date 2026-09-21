-- Migration: Zusagen-Task (#696, Bauauftrag Standup 21.09.2026, Fall Lorenzo U19)
-- Created: 2026-09-21
--
-- Eine Zusage im Entwurf (Judge-Flag promises_action) legt einen SmartTasks-Task an
-- Micha an, statt das Auto-Send-Gate zu blockieren — siehe promise-task-service.ts.
-- smarttasks_task_guest_message_id trägt die Id der zuletzt beantworteten Gastnachricht
-- (messages.id) zum Zeitpunkt der Task-Anlage: Idempotenz-Schlüssel für Re-Generate im
-- selben Thread zur selben Gastnachricht (z. B. nach einer Sprach-Pin-Korrektur) — ein
-- neuer Draft für DIESELBE Gastnachricht findet über diese Spalte den bestehenden Task
-- wieder, statt einen zweiten anzulegen (Spec Punkt 6).
ALTER TABLE message_drafts ADD COLUMN smarttasks_task_id INTEGER;
ALTER TABLE message_drafts ADD COLUMN smarttasks_task_guest_message_id TEXT;

CREATE INDEX idx_message_drafts_smarttasks_task ON message_drafts(thread_id, smarttasks_task_guest_message_id);
