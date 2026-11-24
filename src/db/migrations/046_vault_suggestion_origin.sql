-- Migration 046: Vault-Vorschläge ohne Entwurfs-Feedback + Herkunft (#1295)
--
-- Die Agent-API legt Vorschläge aus der Diff-Auswertung direkt an (POST /api/agent/vault-suggestions).
-- Die haben kein draft_feedback → feedback_id wird nullable. Neue Spalte origin:
--   'feedback'        = Feedback-Loop im Admin-UI (Default, gilt für alle Bestandszeilen)
--   'diff-auswertung' = Agent-API (Default der Route), andere Werte möglich
--
-- SQLite kann NOT NULL nicht per ALTER entfernen → Tabelle neu aufbauen. Keine andere Tabelle
-- referenziert vault_suggestions; der FK feedback_id → draft_feedback (ON DELETE CASCADE) bleibt,
-- NULL wird vom FK nicht geprüft. rowid wird übernommen (Tiebreaker in getSuggestionsByStatus).
-- Verwaiste feedback_id (Feedback gelöscht, während foreign_keys aus war) wird beim Kopieren NULL,
-- sonst bräche der Rebuild unter foreign_keys=ON beim App-Start ab; origin bleibt 'feedback'.

CREATE TABLE vault_suggestions_new (
  id TEXT PRIMARY KEY,
  feedback_id TEXT,
  target_file TEXT NOT NULL,
  target_heading TEXT NOT NULL,
  addition_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'discarded' | 'revoked'
  applied_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  revoked_at TEXT,
  revoke_commit TEXT,
  origin TEXT NOT NULL DEFAULT 'feedback',
  FOREIGN KEY (feedback_id) REFERENCES draft_feedback(id) ON DELETE CASCADE
);

INSERT INTO vault_suggestions_new (
  rowid, id, feedback_id, target_file, target_heading, addition_text, rationale,
  status, applied_commit, created_at, applied_at, revoked_at, revoke_commit, origin
)
SELECT
  rowid, id,
  CASE WHEN feedback_id IN (SELECT id FROM draft_feedback) THEN feedback_id ELSE NULL END,
  target_file, target_heading, addition_text, rationale,
  status, applied_commit, created_at, applied_at, revoked_at, revoke_commit, 'feedback'
FROM vault_suggestions;

DROP TABLE vault_suggestions;
ALTER TABLE vault_suggestions_new RENAME TO vault_suggestions;

CREATE INDEX idx_vault_suggestions_status ON vault_suggestions(status);
