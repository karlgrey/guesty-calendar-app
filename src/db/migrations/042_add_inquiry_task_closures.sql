-- Migration 042: Selbstschluss beantworteter Inquiry-Tasks (#1210, Entscheidung Micha 17.11.2026)
--
-- Sobald die Antwort auf eine Airbnb-Inquiry gesendet ist (Versand über die App oder direkt in
-- Airbnb, per Sync gesehen), setzt die App den Buchungsanfrage-Task (#697) auf Done und
-- kommentiert. Diese Tabelle ist der Idempotenz-Anker: je SmartTasks-Task höchstens EIN
-- Schließ-Versuch mit Ergebnis — mehrfacher Sync schließt/kommentiert nie doppelt.
--
-- outcome: 'pending' (Claim, Versuch läuft) | 'closed' (von der App auf Done gesetzt) |
--          'skipped' (schon von Hand geschlossen/verworfen oder dauerhaft nicht schließbar) |
--          'legacy' (Task bestand vor dieser Migration — Tabu: nicht rückwirkend schließen)
CREATE TABLE IF NOT EXISTS inquiry_task_closures (
  task_id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  answered_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bestehende Inquiry-Tasks bleiben unangetastet (Sichtung macht die Hauptsession).
INSERT OR IGNORE INTO inquiry_task_closures (task_id, thread_id, outcome, detail)
  SELECT smarttasks_task_id, MIN(thread_id), 'legacy', 'vor #1210 angelegt'
  FROM message_drafts
  WHERE request_kind = 'inquiry' AND smarttasks_task_id IS NOT NULL
  GROUP BY smarttasks_task_id;
