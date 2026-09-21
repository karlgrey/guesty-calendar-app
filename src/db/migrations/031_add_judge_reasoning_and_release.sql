-- Migration: Judge-Begründung persistieren + Auto-Send-Freigabe je Thread (#702, Bauauftrag
-- Standup 21.09.2026, Fall Anika Farmhouse)
-- Created: 2026-09-21
--
-- auto_judge_reasoning (Spec Punkt 4): das Feld "reasoning" des judge_draft-Tools
-- (types.ts JudgeVerdict.reasoning) wurde bisher nur geloggt, nicht persistiert — eine
-- Einordnung wie im Fall Anika ließ sich im Nachhinein nicht erklären. auto_reason bleibt
-- unverändert der Policy-Text (policy.ts decide()); auto_judge_reasoning ist zusätzlich der
-- Ein-bis-zwei-Satz-Text des Prüfmodells selbst.
--
-- auto_send_released_at (Spec Punkt 2): threadHasFailedSend (draft-repository.ts) sperrte
-- einen Thread bisher DAUERHAFT, sobald irgendein Draft je auf status='error'/'sending'
-- stand — irreversibel (Final-Review-Nachzieh-Punkt aus #686). Micha gibt den Thread jetzt
-- über einen Admin-UI-Button ("Auto-Send für diesen Thread wieder erlauben",
-- POST /admin/messages/:threadId/release-auto-send) frei — threadHasFailedSend zählt danach
-- nur noch Drafts, die NACH der Freigabe angelegt wurden (created_at > auto_send_released_at).
ALTER TABLE message_drafts ADD COLUMN auto_judge_reasoning TEXT;
ALTER TABLE message_threads ADD COLUMN auto_send_released_at TEXT;
